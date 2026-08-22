import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { authStatePath } from "./auth.js";
import { log } from "./log.js";
import type { EvalConfig, Scenario, ScenarioEvidence, ScreenshotRef, TranscriptEntry } from "./types.js";
import { BrowserSession } from "./browser.js";
import { FIXTURES_DIR } from "./specs.js";
import { TOOL_DEFS } from "./tools.js";
import { browseGuidance, scenarioBrief } from "./brief.js";

// Same tools the MCP server exposes to a harness agent — one definition, so the
// two drive paths cannot drift apart.
const TOOLS: Anthropic.ToolUnion[] = TOOL_DEFS as Anthropic.ToolUnion[];

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "… (truncated)" : s);

/** Actions after which a URL change triggers an automatic evidence screenshot. */
const AUTO_SHOT_TOOLS = new Set(["navigate", "click", "press"]);

/**
 * Runs one scenario with a manual agentic loop (custom client-side tools,
 * screenshots returned to the model as image blocks).
 */
export async function runScenario(opts: {
  client: Anthropic;
  config: EvalConfig;
  scenario: Scenario;
  areaTitle: string;
  fixtures: Record<string, unknown>;
  evidenceDir: string;
}): Promise<ScenarioEvidence> {
  const { client, config, scenario, areaTitle, fixtures, evidenceDir } = opts;
  const startedAt = new Date().toISOString();
  const transcript: TranscriptEntry[] = [];
  const screenshots: ScreenshotRef[] = [];
  const observations: string[] = [];
  const maxTurns = config.maxTurnsPerScenario ?? 40;

  // Restore a pre-authenticated session for this persona when one was captured.
  const statePath = authStatePath(scenario.persona, config.url);
  const preAuthed = fs.existsSync(statePath);
  const browser = new BrowserSession(
    evidenceDir,
    config.headless ?? true,
    new URL(config.url).origin,
    preAuthed ? statePath : undefined,
  );

  let outcome: ScenarioEvidence["outcome"] = "agent_error";
  let summary = "Scenario did not finish.";
  let finalUrl: string | undefined;
  let started = false;
  let lastShotUrl: string | undefined;
  // Consecutive turns that ended on a login wall while we began authenticated.
  let loggedOutStreak = 0;
  let turn = 0;

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: scenarioBrief({ config, scenario, areaTitle, fixtures, preAuthed }),
        },
      ],
    },
  ];

  try {
    await browser.start();
    started = true;

    while (turn < maxTurns) {
      turn += 1;
      const response = await client.messages.create({
        model: config.agentModel!,
        max_tokens: 16000,
        cache_control: { type: "ephemeral" },
        ...(config.agentReasoningEffort
          ? { output_config: { effort: config.agentReasoningEffort } }
          : {}),
        system: browseGuidance(config.url, config),
        tools: TOOLS,
        messages,
      });

      if (response.stop_reason === "refusal") {
        outcome = "agent_error";
        summary = "Model refused mid-scenario (safety classifier). Re-run or verify this scenario manually.";
        break;
      }

      for (const block of response.content) {
        if (block.type === "text" && block.text.trim()) {
          transcript.push({ turn, kind: "assistant_text", detail: clip(block.text, 600) });
        }
      }

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      if (toolUses.length > 0) {
        const summary = toolUses
          .map((t) => {
            const i = t.input as Record<string, any>;
            const arg = i.url ?? i.label ?? i.ref ?? i.note ?? i.outcome ?? i.key ?? "";
            return `${t.name}${arg ? `(${String(arg).slice(0, 40)})` : ""}`;
          })
          .join(", ");
        log(`      ${scenario.id} turn ${turn}/${maxTurns}: ${summary}`);
      }

      if (toolUses.length === 0) {
        if (response.stop_reason === "max_tokens") {
          // Truncated mid-thought with no complete tool call — nudge and retry
          // rather than mistaking the fragment for a finished scenario.
          transcript.push({
            turn,
            kind: "assistant_text",
            detail: "(turn truncated at max_tokens with no tool call — nudged to continue)",
          });
          messages.push({ role: "assistant", content: response.content });
          messages.push({
            role: "user",
            content:
              "Your last turn was cut off by the output limit before any tool call. Continue the scenario now: be brief in prose and go straight to the next tool call (or call done if the scenario is finished).",
          });
          continue;
        }
        // end_turn without calling done — accept the text as the summary.
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        outcome = "completed";
        summary = text || "Agent ended the scenario without an explicit summary.";
        break;
      }

      messages.push({ role: "assistant", content: response.content });

      const results: Anthropic.ToolResultBlockParam[] = [];
      let finished = false;

      for (const tu of toolUses) {
        const input = tu.input as Record<string, any>;
        transcript.push({
          turn,
          kind: "tool_call",
          tool: tu.name,
          detail: clip(JSON.stringify(input), 400),
        });

        let content: Anthropic.ToolResultBlockParam["content"];
        let isError = false;
        try {
          switch (tu.name) {
            case "navigate": {
              const target = new URL(String(input.url), config.url);
              // Use the session's own containment rule — an exact-origin check
              // here would reject sibling subdomains that the browser layer
              // allows (e.g. a public site on sites.example.com), silently
              // making a whole product surface unreachable.
              if (!browser.isAllowedUrl(target.toString())) {
                content = `ERROR: ${target.origin} is off-target. Stay on ${new URL(config.url).origin} or a sibling subdomain of the same site.`;
                isError = true;
              } else {
                content = await browser.navigate(target.toString());
              }
              break;
            }
            case "snapshot":
              content = await browser.snapshot();
              break;
            case "click":
              content = await browser.click(String(input.ref));
              break;
            case "fill":
              content = await browser.fill(String(input.ref), String(input.text));
              break;
            case "select":
              content = await browser.select(String(input.ref), String(input.value));
              break;
            case "drag":
              content = await browser.drag(String(input.from_ref), String(input.to_ref));
              break;
            case "upload": {
              const fixtureFiles: Record<string, string> = {
                headshot: "headshot.png",
                slides: "slides.pdf",
                speakers_csv: "speakers.csv",
              };
              const file = fixtureFiles[String(input.fixture)];
              if (!file) {
                content = `ERROR: unknown fixture '${input.fixture}'. Use headshot | slides | speakers_csv.`;
                isError = true;
              } else {
                content = await browser.upload(String(input.ref), path.join(FIXTURES_DIR, file));
              }
              break;
            }
            case "press":
              content = await browser.press(String(input.key));
              break;
            case "scroll":
              content = await browser.scroll(
                input.direction === "up" ? "up" : "down",
                input.ref ? String(input.ref) : undefined,
              );
              break;
            case "wait":
              content = await browser.wait(Number(input.ms) || 1000);
              break;
            case "screenshot": {
              const shot = await browser.screenshot(String(input.label ?? "shot"), Boolean(input.full_page));
              screenshots.push({ path: shot.relPath, label: String(input.label ?? "shot"), turn });
              content = [
                { type: "text", text: `Screenshot saved as ${shot.relPath}` },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/jpeg", data: shot.base64 },
                },
              ];
              break;
            }
            case "observe":
              observations.push(String(input.note));
              content = "Observation recorded.";
              break;
            case "done": {
              const allowed: ScenarioEvidence["outcome"][] = [
                "completed",
                "blocked",
                "feature_not_found",
              ];
              outcome = allowed.includes(input.outcome)
                ? (input.outcome as ScenarioEvidence["outcome"])
                : "completed";
              summary = String(input.summary ?? "");
              content = "Scenario ended.";
              finished = true;
              break;
            }
            default:
              content = `ERROR: unknown tool ${tu.name}`;
              isError = true;
          }
        } catch (err: any) {
          content = `ERROR: ${err?.message ?? String(err)}`;
          isError = true;
        }

        transcript.push({
          turn,
          kind: "tool_result",
          tool: tu.name,
          detail:
            typeof content === "string"
              ? clip(content, 500)
              : `(screenshot returned: ${screenshots.at(-1)?.path ?? ""})`,
        });

        // Session-health guard. A pre-authenticated run that lands on a login
        // wall has lost its session (shared-domain cookies, idle timeout, an
        // impersonation switch). Continuing means exploring a logged-out app
        // and reporting real features as missing, so stop and say why.
        if (preAuthed && !isError) {
          const url = browser.page?.url() ?? "";
          const wall =
            /[?&/](login|signin|sign-in)\b/i.test(url) || /reason=sessionExpired/i.test(url);
          loggedOutStreak = wall ? loggedOutStreak + 1 : 0;
          if (loggedOutStreak >= 2) {
            outcome = "blocked";
            summary =
              `Session lost mid-scenario: this run started pre-authenticated but the app redirected to a login wall (${url.slice(0, 140)}) and stayed there. ` +
              `Everything after this point would be observed while logged out, so the scenario was stopped rather than reporting features as missing. ` +
              `Re-capture the persona's session (sbek auth) and re-run this scenario.`;
            observations.push(`SESSION LOST: redirected to ${url.slice(0, 160)} while pre-authenticated.`);
            transcript.push({ turn, kind: "assistant_text", detail: "(halted: session lost)" });
            finished = true;
            break;
          }
        }

        // Auto-capture evidence whenever an action lands on a new page. These
        // are saved for the judge but NOT returned to the model, so richer
        // evidence costs no agent tokens — models under-screenshot in practice.
        if (AUTO_SHOT_TOOLS.has(tu.name) && !isError) {
          try {
            const url = browser.page?.url();
            // Don't spend the judge's image budget on 404s from URL probing —
            // a failed guess is worth an observation, not a screenshot.
            const title = typeof content === "string" ? (content.match(/^TITLE: (.*)$/m)?.[1] ?? "") : "";
            const isErrorPage = /404|not found|could not be found/i.test(title);
            if (url && url !== lastShotUrl && !isErrorPage) {
              lastShotUrl = url;
              const slug = url.replace(/^https?:\/\/[^/]+/, "").replace(/[^a-z0-9]+/gi, "-") || "root";
              const shot = await browser.screenshot(`auto${slug}`.slice(0, 55), false);
              screenshots.push({ path: shot.relPath, label: `auto: ${url}`, turn });
            }
          } catch {
            /* evidence capture is best-effort */
          }
        }

        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content,
          ...(isError ? { is_error: true } : {}),
        });
      }

      messages.push({ role: "user", content: results });
      if (finished) break;
    }

    if (turn >= maxTurns && outcome === "agent_error") {
      summary = `Turn limit (${maxTurns}) reached before the scenario finished.`;
    }
  } catch (err: any) {
    // Harness-level failure (API error after SDK retries, browser crash, ...):
    // degrade to agent_error so the run continues and evidence so far is kept.
    outcome = "agent_error";
    summary = `Harness error on turn ${turn}: ${err?.message ?? String(err)}`;
  } finally {
    if (started) {
      // Terminal-state screenshot for the judge, best-effort.
      try {
        const shot = await browser.screenshot("final-state", false);
        screenshots.push({ path: shot.relPath, label: "final-state", turn });
      } catch {}
      try {
        finalUrl = browser.page?.url();
      } catch {}
    }
    await browser.stop();
  }

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    outcome,
    summary,
    observations,
    transcript,
    screenshots,
    startedAt,
    finishedAt: new Date().toISOString(),
    finalUrl,
    turns: turn,
  };
}
