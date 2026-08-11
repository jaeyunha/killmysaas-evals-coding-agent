/**
 * sbek MCP server — the harness drive path.
 *
 * Run scenarios from INSIDE a coding agent (Claude Code, Codex CLI) with no
 * Anthropic API calls: this process holds one BrowserSession open across many
 * tool calls, and the harness's own model decides what to click.
 *
 * Why a server at all: refs like 'e12' are data-sbek-ref attributes stamped on
 * the DOM during the last snapshot, and the browser is a live Chromium process.
 * Both die the moment the process exits, so a one-shot `node -e` per action
 * would boot a cold browser every time. The server is simply the thing that
 * stays alive.
 *
 * Evidence lands in exactly the same layout the API path writes, so `sbek score`,
 * `rescore`, `finalize` and the HTML report cannot tell which path produced a run.
 */
import fs from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { BrowserSession } from "./browser.js";
import { authStatePath } from "./auth.js";
import { loadConfig, newRunDir } from "./config.js";
import { loadFixtures, loadSpecs, FIXTURES_DIR } from "./specs.js";
import { browseGuidance, scenarioBrief } from "./brief.js";
import { TOOL_DEFS } from "./tools.js";
import { CURRENT_RUN_FILE, readCurrentRun, writeCurrentRun } from "./runstate.js";
import type { EvalConfig, Scenario, ScreenshotRef, Spec, TranscriptEntry } from "./types.js";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "… (truncated)" : s);

/** Actions after which a URL change triggers an automatic evidence screenshot. */
const AUTO_SHOT_TOOLS = new Set(["navigate", "click", "press"]);

interface Session {
  scenario: Scenario;
  spec: Spec;
  runDir: string;
  evidenceDir: string;
  browser: BrowserSession;
  preAuthed: boolean;
  transcript: TranscriptEntry[];
  screenshots: ScreenshotRef[];
  observations: string[];
  startedAt: string;
  turn: number;
  lastShotUrl?: string;
  loggedOutStreak: number;
}

let session: Session | null = null;

function config(): EvalConfig {
  return loadConfig({
    command: "mcp",
    flags: { config: process.env.SBEK_CONFIG ?? "evalconfig.json" },
  });
}

const text = (s: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text: s }],
  ...(isError ? { isError: true } : {}),
});

// ---------------------------------------------------------------------------
// Scenario lifecycle
// ---------------------------------------------------------------------------

const START_TOOL = {
  name: "start_scenario",
  description:
    "Open a browser and begin one eval scenario. Returns the full brief: ground rules, the script to execute, the persona, and the sample data to type into forms. Call this FIRST — every other browser tool errors until a scenario is open. Restores a saved persona session when `sbek auth` captured one.",
  input_schema: {
    type: "object" as const,
    properties: {
      scenario_id: { type: "string", description: "e.g. 'CFP-S1' — see `sbek plan` or `sbek list`" },
      run_dir: {
        type: "string",
        description:
          "Optional: write evidence into this existing run directory. Defaults to the current run (.sbek-current-run), creating one if none exists.",
      },
    },
    required: ["scenario_id"],
  },
};

const ABORT_TOOL = {
  name: "abort_scenario",
  description:
    "Close the browser WITHOUT writing evidence.json. Use only to recover from a wedged session before restarting the same scenario — a scenario that genuinely could not be completed should end with done(outcome:'blocked') so the judge sees why.",
  input_schema: { type: "object" as const, properties: {} },
};

async function startScenario(input: Record<string, any>): Promise<CallToolResult> {
  if (session) {
    return text(
      `ERROR: scenario ${session.scenario.id} is already open. Finish it with done(...) or discard it with abort_scenario.`,
      true,
    );
  }
  const scenarioId = String(input.scenario_id ?? "");
  const specs = loadSpecs();
  const spec = specs.find((s) => s.scenarios.some((sc) => sc.id === scenarioId));
  const scenario = spec?.scenarios.find((sc) => sc.id === scenarioId);
  if (!spec || !scenario) {
    const known = specs.flatMap((s) => s.scenarios.map((sc) => sc.id));
    return text(`ERROR: unknown scenario '${scenarioId}'. Known: ${known.join(", ")}`, true);
  }

  const cfg = config();
  const runDir = String(input.run_dir ?? "") || readCurrentRun() || newRunDir();
  writeCurrentRun(runDir);
  const evidenceDir = path.join(runDir, scenario.id);
  fs.mkdirSync(evidenceDir, { recursive: true });

  const statePath = authStatePath(scenario.persona, cfg.url);
  const preAuthed = fs.existsSync(statePath);
  const browser = new BrowserSession(
    evidenceDir,
    cfg.headless ?? true,
    new URL(cfg.url).origin,
    preAuthed ? statePath : undefined,
  );
  await browser.start();

  session = {
    scenario,
    spec,
    runDir,
    evidenceDir,
    browser,
    preAuthed,
    transcript: [],
    screenshots: [],
    observations: [],
    startedAt: new Date().toISOString(),
    turn: 0,
    loggedOutStreak: 0,
  };

  const fixtures = loadFixtures(cfg);
  return text(
    [
      browseGuidance(cfg.url, cfg),
      ``,
      `--- SCENARIO BRIEF ---`,
      ``,
      scenarioBrief({ config: cfg, scenario, areaTitle: spec.title, fixtures, preAuthed }),
      ``,
      `--- ---`,
      `Evidence directory: ${evidenceDir}`,
      `Suggested budget: ~${cfg.maxTurnsPerScenario ?? 70} tool calls. Screenshot every meaningful state; record observations liberally; finish with done(...).`,
    ].join("\n"),
  );
}

/** Writes evidence.json in the exact shape the API path produces. */
async function finishScenario(
  outcome: "completed" | "blocked" | "feature_not_found" | "agent_error",
  summary: string,
): Promise<string> {
  const s = session!;
  let finalUrl: string | undefined;
  try {
    const shot = await s.browser.screenshot("final-state", false);
    s.screenshots.push({ path: shot.relPath, label: "final-state", turn: s.turn });
  } catch {
    /* terminal screenshot is best-effort */
  }
  try {
    finalUrl = s.browser.page?.url();
  } catch {
    /* ignore */
  }
  await s.browser.stop();

  const evidence = {
    scenarioId: s.scenario.id,
    scenarioName: s.scenario.name,
    outcome,
    summary,
    observations: s.observations,
    transcript: s.transcript,
    screenshots: s.screenshots,
    startedAt: s.startedAt,
    finishedAt: new Date().toISOString(),
    finalUrl,
    turns: s.turn,
  };
  const file = path.join(s.evidenceDir, "evidence.json");
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2));
  const { runDir, spec } = s;
  session = null;

  const remaining = spec.scenarios.filter(
    (sc) => !fs.existsSync(path.join(runDir, sc.id, "evidence.json")),
  );
  return [
    `Scenario ended: ${outcome}.`,
    `Evidence written: ${file} (${evidence.screenshots.length} screenshots, ${evidence.observations.length} observations, ${s.turn} tool calls).`,
    remaining.length
      ? `Remaining scenarios in ${spec.area}: ${remaining.map((r) => r.id).join(", ")}`
      : `All scenarios in ${spec.area} have evidence — judge it next: sbek judge-brief --area ${spec.area}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Browser tool dispatch
// ---------------------------------------------------------------------------

async function dispatch(name: string, input: Record<string, any>): Promise<CallToolResult> {
  if (!session) {
    return text(`ERROR: no scenario open. Call start_scenario first.`, true);
  }
  const s = session;
  const cfg = config();
  s.turn += 1;
  s.transcript.push({
    turn: s.turn,
    kind: "tool_call",
    tool: name,
    detail: clip(JSON.stringify(input), 400),
  });

  let result: CallToolResult;
  let isError = false;
  let detail = "";

  try {
    switch (name) {
      case "navigate": {
        const target = new URL(String(input.url), cfg.url);
        // Use the session's own containment rule — an exact-origin check here
        // would reject sibling subdomains the browser layer allows.
        if (!s.browser.isAllowedUrl(target.toString())) {
          isError = true;
          detail = `ERROR: ${target.origin} is off-target. Stay on ${new URL(cfg.url).origin} or a sibling subdomain of the same site.`;
        } else {
          detail = await s.browser.navigate(target.toString());
        }
        break;
      }
      case "snapshot":
        detail = await s.browser.snapshot();
        break;
      case "click":
        detail = await s.browser.click(String(input.ref));
        break;
      case "fill":
        detail = await s.browser.fill(String(input.ref), String(input.text));
        break;
      case "select":
        detail = await s.browser.select(String(input.ref), String(input.value));
        break;
      case "drag":
        detail = await s.browser.drag(String(input.from_ref), String(input.to_ref));
        break;
      case "upload": {
        const fixtureFiles: Record<string, string> = {
          headshot: "headshot.png",
          slides: "slides.pdf",
          speakers_csv: "speakers.csv",
        };
        const file = fixtureFiles[String(input.fixture)];
        if (!file) {
          isError = true;
          detail = `ERROR: unknown fixture '${input.fixture}'. Use headshot | slides | speakers_csv.`;
        } else {
          detail = await s.browser.upload(String(input.ref), path.join(FIXTURES_DIR, file));
        }
        break;
      }
      case "press":
        detail = await s.browser.press(String(input.key));
        break;
      case "scroll":
        detail = await s.browser.scroll(
          input.direction === "up" ? "up" : "down",
          input.ref ? String(input.ref) : undefined,
        );
        break;
      case "wait":
        detail = await s.browser.wait(Number(input.ms) || 1000);
        break;
      case "observe":
        s.observations.push(String(input.note));
        detail = "Observation recorded.";
        break;
      case "screenshot": {
        const label = String(input.label ?? "shot");
        const shot = await s.browser.screenshot(label, Boolean(input.full_page));
        s.screenshots.push({ path: shot.relPath, label, turn: s.turn });
        s.transcript.push({
          turn: s.turn,
          kind: "tool_result",
          tool: name,
          detail: `(screenshot saved: ${shot.relPath})`,
        });
        return {
          content: [
            { type: "text", text: `Screenshot saved as ${shot.relPath}` },
            { type: "image", data: shot.base64, mimeType: "image/jpeg" },
          ],
        };
      }
      case "done": {
        const allowed = ["completed", "blocked", "feature_not_found"] as const;
        const outcome = (allowed as readonly string[]).includes(String(input.outcome))
          ? (String(input.outcome) as (typeof allowed)[number])
          : "completed";
        const msg = await finishScenario(outcome, String(input.summary ?? ""));
        return text(msg);
      }
      default:
        isError = true;
        detail = `ERROR: unknown tool ${name}`;
    }
  } catch (err: any) {
    isError = true;
    detail = `ERROR: ${err?.message ?? String(err)}`;
  }

  s.transcript.push({
    turn: s.turn,
    kind: "tool_result",
    tool: name,
    detail: clip(detail, 500),
  });

  // Session-health guard. A pre-authenticated run that lands on a login wall
  // has lost its session (shared-domain cookies, idle timeout, an impersonation
  // switch). Continuing means exploring a logged-out app and reporting real
  // features as missing, so surface it loudly rather than letting it slide.
  if (s.preAuthed && !isError) {
    const url = s.browser.page?.url() ?? "";
    const wall = /[?&/](login|signin|sign-in)\b/i.test(url) || /reason=sessionExpired/i.test(url);
    s.loggedOutStreak = wall ? s.loggedOutStreak + 1 : 0;
    if (s.loggedOutStreak >= 2) {
      s.observations.push(`SESSION LOST: redirected to ${url.slice(0, 160)} while pre-authenticated.`);
      const msg = await finishScenario(
        "blocked",
        `Session lost mid-scenario: this run started pre-authenticated but the app redirected to a login wall (${url.slice(0, 140)}) and stayed there. ` +
          `Everything after this point would be observed while logged out, so the scenario was stopped rather than reporting features as missing. ` +
          `Re-capture the persona's session (sbek auth) and re-run this scenario.`,
      );
      return text(
        `SCENARIO HALTED — session lost.\n\nThe browser is pre-authenticated but landed on a login wall twice in a row, so everything from here would be observed logged out. The scenario was closed as 'blocked'.\n\n${msg}\n\nRecover with: pnpm run sbek -- auth --persona ${s.scenario.persona}`,
        true,
      );
    }
  }

  // Auto-capture evidence whenever an action lands on a new page. Saved for the
  // judge but NOT returned to the model, so richer evidence costs no context —
  // models under-screenshot in practice.
  if (AUTO_SHOT_TOOLS.has(name) && !isError) {
    try {
      const url = s.browser.page?.url();
      // Don't spend the judge's image budget on 404s from URL probing.
      const title = detail.match(/^TITLE: (.*)$/m)?.[1] ?? "";
      const isErrorPage = /404|not found|could not be found/i.test(title);
      if (url && url !== s.lastShotUrl && !isErrorPage) {
        s.lastShotUrl = url;
        const slug = url.replace(/^https?:\/\/[^/]+/, "").replace(/[^a-z0-9]+/gi, "-") || "root";
        const shot = await s.browser.screenshot(`auto${slug}`.slice(0, 55), false);
        s.screenshots.push({ path: shot.relPath, label: `auto: ${url}`, turn: s.turn });
      }
    } catch {
      /* evidence capture is best-effort */
    }
  }

  result = text(detail, isError);
  return result;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "sbek", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [START_TOOL, ...TOOL_DEFS, ABORT_TOOL].map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema as any,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const input = (req.params.arguments ?? {}) as Record<string, any>;
  try {
    if (name === "start_scenario") return await startScenario(input);
    if (name === "abort_scenario") {
      if (!session) return text("No scenario open.");
      const id = session.scenario.id;
      await session.browser.stop();
      session = null;
      return text(`Aborted ${id} without writing evidence.json. Restart it with start_scenario.`);
    }
    return await dispatch(name, input);
  } catch (err: any) {
    return text(`ERROR: ${err?.message ?? String(err)}`, true);
  }
});

// A crashed harness must not leave Chromium running.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    try {
      if (session) await session.browser.stop();
    } catch {
      /* shutting down anyway */
    }
    process.exit(0);
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout is the MCP channel — never log there.
console.error(`sbek MCP server ready (config: ${process.env.SBEK_CONFIG ?? "evalconfig.json"}, run pointer: ${CURRENT_RUN_FILE})`);
