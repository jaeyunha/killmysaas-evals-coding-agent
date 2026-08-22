import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig, newRunDir, parseArgs, KIT_VERSION, MIN_COVERAGE_PCT } from "./config.js";
import { loadFixtures, loadSpecs, selectSpecs } from "./specs.js";
import { captureAuth, hasAuthState } from "./auth.js";
import { initLog, log, closeLog } from "./log.js";
import { runScenario } from "./agent.js";
import { judgeArea } from "./judge.js";
import { buildReport, scoreArea, writeHtmlReport, writeManualChecklist, finalizeReport } from "./report.js";
import {
  evidencePath,
  judgementPath,
  loadAreaEvidence,
  renderEvidence,
  selectScreenshots,
} from "./evidence.js";
import { JUDGE_SYSTEM, JudgementSchema, renderRubric } from "./judgement.js";
import { CURRENT_RUN_FILE, resolveRunDir, writeCurrentRun } from "./runstate.js";
import {
  applyManifestModels,
  captureEvaluatorProvenance,
  createRunManifest,
  modelsForReport,
  readRunManifest,
  writeRunManifest,
} from "./manifest.js";
import type { AreaScore, RunReport, ScenarioEvidence } from "./types.js";

const HELP = `sbek — SessionBoard Eval Kit v${KIT_VERSION}

Usage:
  pnpm run sbek -- <command> [flags]

Commands:
  list                         Show feature areas, scenarios, and rubric coverage
  run --url <url>              Evaluate a submission URL
      [--areas a,b,c]          Only these area slugs
      [--scenarios ID,ID]      Only these scenario ids (within the selected areas)
      [--max-turns N]          Cap agent turns per scenario (default 70)
      [--include-optional]     Include optional (extra-credit) areas
      [--resume <run dir>]     Continue a previous run: completed scenarios and
                               scored areas are reused, nothing is re-paid for
      [--config <file>]        Config file (default evalconfig.json)
      [--dry-run]              Validate specs + print the plan; no browser, no API calls
      [--headed]               Show the browser window
      [--agent-model <id>] [--judge-model <id>]
      [--agent-reasoning-effort <level>] [--judge-reasoning-effort <level>]
      [--candidate-sha <sha>] [--api-worker-version-id <id>] [--web-worker-version-id <id>]
  auth --persona <name>        Sign in once by hand in a real browser window and save
       [--at /login]           the session, so scenarios for that persona start already
       [--click "<text>"]      logged in (for magic-link / OAuth submissions).
       [--url <url>]           --at opens a specific page instead of the site root.
                               --click "<text>" completes a one-click demo login with no
                               human step (headless); omit it for a hands-on login.
                               Personas: organizer | speaker | reviewer | attendee

Run it yourself, inside Claude Code / Codex (no API key, no 'run' command).
The agent already in your session does the browsing and the judging:
  plan --url <url>             Start a run and print the scenario checklist
      [--areas a,b,c] [--scenarios ID,ID] [--include-optional] [--run <dir>]
      [--candidate-sha <sha>] [--api-worker-version-id <id>] [--web-worker-version-id <id>]
                               Then drive the browser via the 'sbek' MCP server:
                               start_scenario -> snapshot/click/fill/... -> done
  judge-brief --area <slug>    Print the rubric + evidence + screenshot paths for
      [--run <dir>]            one area, and where to write judgements/<area>.json.
                               Run this in a FRESH session so browsing context
                               cannot bias the verdicts.
  score [--run <dir>]          Validate judgements/*.json and build the report
      [--areas a,b,c]

  rescore --run <dir>          Rebuild report.html/json from a run's stored evidence
                               and judgements (no API calls). Re-run finalize after.
  finalize --run <dir>         Merge manual-results.json into the report and rescore

Environment:
  ANTHROPIC_API_KEY            required for 'run' only — the harness path
                               (plan / judge-brief / score) never calls the API
`;

const EVALUATOR_ROOT = path.resolve(import.meta.dirname, "..");

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help" || args.command === "--help") {
    console.log(HELP);
    return;
  }

  if (args.command === "list") {
    const specs = loadSpecs();
    for (const s of specs) {
      const auto = s.rubric.filter((r) => r.testability === "auto").length;
      const partial = s.rubric.filter((r) => r.testability === "auto-partial").length;
      const manual = s.rubric.filter((r) => r.testability === "manual").length;
      console.log(
        `${s.area.padEnd(28)} ${s.title.padEnd(34)} ${String(s.scenarios.length).padStart(2)} scenarios  rubric: ${auto} auto / ${partial} partial / ${manual} manual${s.optional ? "  (optional)" : ""}`,
      );
    }
    return;
  }

  if (args.command === "auth") {
    const persona = String(args.flags.persona ?? "");
    if (!persona) throw new Error("auth requires --persona <organizer|speaker|reviewer|attendee>");
    const config = loadConfig(args);
    const startAt = typeof args.flags.at === "string" ? args.flags.at : undefined;
    const autoClick = typeof args.flags.click === "string" ? args.flags.click : undefined;
    const saved = await captureAuth(persona, config, startAt, autoClick);
    console.log(`\nDone. Re-run this command any time the session expires: ${saved}`);
    return;
  }

  if (args.command === "rescore") {
    const runDir = String(args.flags.run ?? "");
    if (!runDir) throw new Error("rescore requires --run <dir>");
    const specs = loadSpecs();
    const prior: RunReport = JSON.parse(fs.readFileSync(path.join(runDir, "report.json"), "utf8"));
    const areas = prior.areas.map((a) => {
      const spec = specs.find((s) => s.area === a.area);
      if (!spec) throw new Error(`No spec for area "${a.area}" — was it renamed or removed?`);
      // Judged verdicts and evidence are both persisted in the report, so the
      // whole report can be rebuilt with current scoring logic, offline.
      return scoreArea(
        spec,
        { area: a.area, items: a.items, defects: a.defects, area_notes: a.notes },
        a.scenarios,
      );
    });
    const rebuilt = buildReport({
      targetUrl: prior.targetUrl,
      startedAt: prior.startedAt,
      models: prior.models,
      areas,
    });
    fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(rebuilt, null, 2));
    writeHtmlReport(runDir, rebuilt);
    writeManualChecklist(runDir, specs, rebuilt);
    console.log(
      `Rescored ${runDir}: ${rebuilt.overallPct ?? "n/a"}% over ${rebuilt.overallCoveragePct}% coverage, ${rebuilt.manualPending} manual item(s) pending.`,
    );
    if (fs.existsSync(path.join(runDir, "manual-results.json"))) {
      console.log("  Note: re-run `finalize` to re-apply any manual verdicts.");
    }
    return;
  }

  if (args.command === "finalize") {
    const runDir = String(args.flags.run ?? "");
    if (!runDir) throw new Error("finalize requires --run <dir>");
    const specs = loadSpecs();
    const report = finalizeReport(runDir, specs);
    console.log(`Finalized. Overall: ${report.overallPct ?? "n/a"}%  (${report.manualPending} manual item(s) still pending)`);
    return;
  }

  // --- harness path -------------------------------------------------------
  // plan → (MCP browsing) → judge-brief → score. No API calls in any of them:
  // the model doing the work is the one already running in Claude Code / Codex.

  if (args.command === "plan") {
    const config = loadConfig(args);
    const specs = selectSpecs(loadSpecs(), config.areas, Boolean(config.includeOptional));
    const runDir = typeof args.flags.run === "string" ? args.flags.run : newRunDir();
    fs.mkdirSync(runDir, { recursive: true });
    writeCurrentRun(runDir);
    if (!fs.existsSync(path.join(runDir, "manifest.json"))) {
      writeRunManifest(
        runDir,
        createRunManifest({
          mode: "plan",
          config,
          specs,
          evaluator: captureEvaluatorProvenance(EVALUATOR_ROOT),
        }),
      );
    }

    const wanted = config.scenarios?.length ? new Set(config.scenarios) : null;
    const rows = specs.flatMap((s) =>
      s.scenarios
        .filter((sc) => !wanted || wanted.has(sc.id))
        .map((sc) => ({ spec: s, sc, done: fs.existsSync(evidencePath(runDir, sc.id)) })),
    );

    console.log(`Run directory: ${runDir}   (remembered in ${CURRENT_RUN_FILE})`);
    console.log(`Target: ${config.url}\n`);

    const personas = [...new Set(rows.map((r) => r.sc.persona))];
    const preAuthed = personas.filter((p) => hasAuthState(p, config.url));
    if (preAuthed.length) console.log(`Pre-authenticated personas: ${preAuthed.join(", ")}`);
    const unauthed = personas.filter((p) => !preAuthed.includes(p) && !config.credentials?.[p]);
    if (unauthed.length) {
      console.log(
        `No saved session or credentials for: ${unauthed.join(", ")}\n  Those scenarios must sign themselves up. Better: pnpm run sbek -- auth --persona <name>`,
      );
    }

    let area = "";
    for (const r of rows) {
      if (r.spec.area !== area) {
        area = r.spec.area;
        console.log(`\n${r.spec.title} (${area})`);
      }
      console.log(
        `  ${r.done ? "[done]" : "[    ]"} ${r.sc.id.padEnd(8)} ${r.sc.name} [${r.sc.persona}]`,
      );
    }

    const next = rows.find((r) => !r.done);
    console.log(
      [
        ``,
        `${rows.filter((r) => r.done).length}/${rows.length} scenarios have evidence.`,
        ``,
        `Next, in this session:`,
        next
          ? `  1. start_scenario({ scenario_id: "${next.sc.id}" })  — the sbek MCP server returns the full brief`
          : `  1. (all scenarios have evidence)`,
        `  2. Drive the browser with snapshot/click/fill/... , screenshot every meaningful state,`,
        `     record observations, and finish with done({ outcome, summary }).`,
        `  3. Repeat until every scenario is [done], then judge each area — in a FRESH`,
        `     session or subagent, so browsing context cannot bias the verdicts:`,
        `       pnpm run sbek -- judge-brief --area <area>`,
        `  4. pnpm run sbek -- score`,
      ].join("\n"),
    );
    return;
  }

  if (args.command === "judge-brief") {
    const runDir = resolveRunDir(typeof args.flags.run === "string" ? args.flags.run : undefined);
    const areaSlug = String(args.flags.area ?? "");
    const specs = loadSpecs();
    if (!areaSlug) {
      console.log(
        `judge-brief requires --area <slug>. Areas: ${specs.map((s) => s.area).join(", ")}`,
      );
      process.exitCode = 1;
      return;
    }
    const spec = specs.find((s) => s.area === areaSlug);
    if (!spec) throw new Error(`Unknown area "${areaSlug}"`);

    const evidence = loadAreaEvidence(runDir, spec);
    const shots = selectScreenshots(evidence, runDir);
    const attached = new Set(shots.map((s) => s.label));
    const autoItems = spec.rubric.filter((r) => r.testability !== "manual");
    const out = judgementPath(runDir, spec.area);
    fs.mkdirSync(path.dirname(out), { recursive: true }); // so a plain redirect works

    console.log(
      [
        JUDGE_SYSTEM,
        ``,
        `=== FEATURE AREA: ${spec.title} (${spec.area}) ===`,
        ``,
        `RUBRIC — return a verdict for every item below, in this order:`,
        renderRubric(autoItems),
        ``,
        `=== EVIDENCE ===`,
        renderEvidence(evidence, attached),
        ``,
        `=== SCREENSHOTS TO READ (${shots.length}) ===`,
        `Read every one of these image files before judging — they are the primary evidence;`,
        `the transcript only says what was attempted, not what actually rendered.`,
        ...shots.map((s) => `  ${s.abs}`),
        ``,
        `=== WRITE YOUR JUDGEMENT ===`,
        `Write JSON to: ${out}`,
        `Shape:`,
        `{`,
        `  "items": [{ "id": "<rubric id>", "verdict": "pass|partial|fail|not_found|cannot_judge|not_applicable",`,
        `              "confidence": "high|medium|low", "reasoning": "...",`,
        `              "evidence_refs": ["${spec.scenarios[0]?.id ?? "SCN"}/screenshots/003-x.jpg", "obs: ...", "turn 12"] }],`,
        `  "defects": [{ "severity": "critical|major|minor", "description": "...", "where": "..." }],`,
        `  "area_notes": "..."`,
        `}`,
        `Then run: pnpm run sbek -- score`,
      ].join("\n"),
    );
    return;
  }

  if (args.command === "score") {
    const runDir = resolveRunDir(typeof args.flags.run === "string" ? args.flags.run : undefined);
    const config = loadConfig(args);
    const specs = selectSpecs(loadSpecs(), config.areas, Boolean(config.includeOptional));
    const areaScores: AreaScore[] = [];

    for (const spec of specs) {
      const evidence = loadAreaEvidence(runDir, spec);
      const file = judgementPath(runDir, spec.area);
      const autoItems = spec.rubric.filter((r) => r.testability !== "manual");

      if (!fs.existsSync(file)) {
        // Unjudged areas score cannot_judge rather than being dropped, so the
        // coverage number tells the truth about how much of the rubric was seen.
        console.log(`  ${spec.area}: no judgement yet (${file}) — items count as cannot_judge`);
        areaScores.push(
          scoreArea(
            spec,
            {
              area: spec.area,
              items: autoItems.map((r) => ({
                id: r.id,
                verdict: "cannot_judge" as const,
                confidence: "low" as const,
                reasoning: `Not judged yet. Run: pnpm run sbek -- judge-brief --area ${spec.area}`,
                evidence_refs: [],
              })),
              defects: [],
              area_notes: "Not judged yet.",
            },
            evidence,
          ),
        );
        continue;
      }

      const parsed = JudgementSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
      if (!parsed.success) {
        throw new Error(
          `${file} does not match the judgement schema:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`,
        );
      }
      const known = new Set(autoItems.map((r) => r.id));
      const unknown = parsed.data.items.filter((i) => !known.has(i.id)).map((i) => i.id);
      if (unknown.length) {
        throw new Error(
          `${file} scores rubric items that do not exist in ${spec.area}: ${unknown.join(", ")}`,
        );
      }
      const missing = autoItems.filter((r) => !parsed.data.items.some((i) => i.id === r.id));
      if (missing.length) {
        console.log(
          `  ${spec.area}: judgement omits ${missing.map((m) => m.id).join(", ")} — those count as cannot_judge`,
        );
      }
      const score = scoreArea(spec, { area: spec.area, ...parsed.data }, evidence);
      console.log(
        `  ${spec.area}: ${score.pct ?? "n/a"}% over ${score.coveragePct}% coverage  manual pending: ${score.pendingManual.length}  defects: ${score.defects.length}`,
      );
      areaScores.push(score);
    }

    const report = buildReport({
      targetUrl: config.url,
      startedAt: areaScores.length
        ? (loadAreaEvidence(runDir, specs[0])[0]?.startedAt ?? new Date().toISOString())
        : new Date().toISOString(),
      models: modelsForReport(readRunManifest(runDir), config),
      areas: areaScores,
    });
    fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
    writeHtmlReport(runDir, report);
    writeManualChecklist(runDir, specs, report);

    if (report.scoreWithheld) {
      console.log(
        `\nSCORE WITHHELD — only ${report.overallCoveragePct}% of rubric weight was judged (need ${MIN_COVERAGE_PCT}%).` +
          `\n  Provisional over the judged subset only: ${report.overallPct ?? "n/a"}% — not comparable across submissions.`,
      );
    } else {
      console.log(
        `\nOverall: ${report.overallPct ?? "n/a"}%  (coverage: ${report.overallCoveragePct}% of rubric weight judged)`,
      );
    }
    console.log(`Report:  ${path.join(runDir, "report.html")}`);
    console.log(`Manual:  ${path.join(runDir, "manual-checklist.md")} (${report.manualPending} item(s))`);
    return;
  }

  if (args.command !== "run") {
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig(args);
  const specs = selectSpecs(loadSpecs(), config.areas, Boolean(config.includeOptional));
  const fixtures = loadFixtures(config);

  if (args.flags["dry-run"]) {
    console.log(`Would evaluate ${config.url} across ${specs.length} area(s):`);
    for (const s of specs) {
      console.log(`\n${s.title} (${s.area})`);
      for (const sc of s.scenarios) console.log(`  scenario ${sc.id}: ${sc.name} [${sc.persona}]`);
      for (const r of s.rubric) console.log(`  rubric   ${r.id} [w${r.weight}, ${r.testability}]`);
    }
    console.log(`\nSpecs valid. Agent model: ${config.agentModel}, judge model: ${config.judgeModel}.`);
    return;
  }

  const client = new Anthropic(); // resolves ANTHROPIC_API_KEY / auth profile from env

  // --resume <dir>: reuse a previous run's completed scenarios and area scores.
  // Scenario evidence.json is written only on completion, so an interrupted
  // scenario has no file and simply re-runs.
  const resumeDir = typeof args.flags.resume === "string" ? args.flags.resume : undefined;
  if (resumeDir && !fs.existsSync(resumeDir)) throw new Error(`No such run dir: ${resumeDir}`);
  const runDir = resumeDir ?? newRunDir();
  if (!resumeDir || !fs.existsSync(path.join(runDir, "manifest.json"))) {
    writeRunManifest(
      runDir,
      createRunManifest({
        mode: "run",
        config,
        specs,
        evaluator: captureEvaluatorProvenance(EVALUATOR_ROOT),
      }),
    );
  }
  const runManifest = readRunManifest(runDir);
  applyManifestModels(config, runManifest);
  const logFile = initLog(runDir);

  const priorAreas = new Map<string, AreaScore>();
  let startedAt = new Date().toISOString();
  if (resumeDir) {
    const priorPath = path.join(runDir, "report.json");
    if (fs.existsSync(priorPath)) {
      const prior: RunReport = JSON.parse(fs.readFileSync(priorPath, "utf8"));
      for (const a of prior.areas) priorAreas.set(a.area, a);
      startedAt = prior.startedAt;
    }
    log(`Resuming ${runDir} — ${priorAreas.size} area(s) already scored`);
  }
  log(`Run dir: ${runDir}`);
  log(`Live log: tail -f ${logFile}`);
  const areaScores: AreaScore[] = [];

  const personas = [...new Set(specs.flatMap((s) => s.scenarios.map((sc) => sc.persona)))];
  const preAuthed = personas.filter((p) => hasAuthState(p, config.url));
  if (preAuthed.length) log(`Pre-authenticated personas: ${preAuthed.join(", ")}`);
  const unauthed = personas.filter((p) => !preAuthed.includes(p) && !config.credentials?.[p]);
  if (unauthed.length) {
    log(
      `No saved session or credentials for: ${unauthed.join(", ")} — those scenarios will sign up themselves, or end 'blocked' if the app requires email verification.`,
    );
    log(`  Tip: pnpm run sbek -- auth --persona <name>`);
  }

  // Incremental persistence: after each area, write a partial report so a
  // crash or API failure late in the run never loses completed area scores.
  const writeArtifacts = () => {
    const report = buildReport({
      targetUrl: config.url,
      startedAt,
      models: modelsForReport(runManifest, config),
      areas: areaScores,
    });
    fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
    writeHtmlReport(runDir, report);
    writeManualChecklist(runDir, specs, report);
    return report;
  };

  for (const spec of specs) {
    log(`\n=== Area: ${spec.title} ===`);

    // Whole area already scored and unchanged? Reuse it — no browser, no API.
    const prior = priorAreas.get(spec.area);
    // pct === null means nothing scored — a failed or refused judge call.
    // Reusing that would bake a harness failure into the report, so re-judge
    // it (evidence is on disk, so this costs one judge call, no browsing).
    const priorComplete =
      prior &&
      prior.pct !== null &&
      spec.scenarios.every((sc) => fs.existsSync(path.join(runDir, sc.id, "evidence.json")));
    if (priorComplete) {
      log(`  reusing scored area from previous run (${prior!.pct ?? "n/a"}%)`);
      areaScores.push(prior!);
      continue;
    }

    const evidence: ScenarioEvidence[] = [];
    let reusedAll = true;

    for (const scenario of spec.scenarios) {
      if (config.scenarios?.length && !config.scenarios.includes(scenario.id)) {
        // Filtered out by --scenarios: record it as not-run so the judge marks
        // dependent rubric items cannot_judge rather than failing them.
        evidence.push({
          scenarioId: scenario.id,
          scenarioName: scenario.name,
          outcome: "blocked",
          summary: "NOT RUN — excluded by the --scenarios filter. No evidence was gathered; rubric items relying on this scenario cannot be judged.",
          observations: [],
          transcript: [],
          screenshots: [],
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          turns: 0,
        });
        continue;
      }
      const personaReady =
        Boolean(config.credentials?.[scenario.persona]) || hasAuthState(scenario.persona, config.url);
      if (scenario.requires_credentials && !personaReady) {
        log(`  ~ ${scenario.id} skipped (needs '${scenario.persona}' credentials)`);
        evidence.push({
          scenarioId: scenario.id,
          scenarioName: scenario.name,
          outcome: "blocked",
          summary: `Skipped: persona '${scenario.persona}' has neither credentials in evalconfig.json nor a saved session (run: sbek auth --persona ${scenario.persona}).`,
          observations: [],
          transcript: [],
          screenshots: [],
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          turns: 0,
        });
        continue;
      }
      const evidenceDir = path.join(runDir, scenario.id);
      const evidenceFile = path.join(evidenceDir, "evidence.json");
      if (fs.existsSync(evidenceFile)) {
        const prev: ScenarioEvidence = JSON.parse(fs.readFileSync(evidenceFile, "utf8"));
        log(`  = ${scenario.id}: reusing evidence (${prev.outcome}, ${prev.screenshots.length} screenshots)`);
        evidence.push(prev);
        continue;
      }

      reusedAll = false;
      log(`  > ${scenario.id}: ${scenario.name} [${scenario.persona}]`);
      fs.mkdirSync(evidenceDir, { recursive: true });
      const result = await runScenario({
        client,
        config,
        scenario,
        areaTitle: spec.title,
        fixtures,
        evidenceDir,
      });
      log(`    outcome: ${result.outcome} (${result.turns} turns, ${result.screenshots.length} screenshots)`);
      evidence.push(result);
      fs.writeFileSync(path.join(evidenceDir, "evidence.json"), JSON.stringify(result, null, 2));
    }

    log(`  judging ${spec.rubric.filter((r) => r.testability !== "manual").length} rubric item(s)...`);
    try {
      const judgement = await judgeArea({ client, config, spec, evidence, runDir });
      const score = scoreArea(spec, judgement, evidence);
      log(
        `  score: ${score.pct ?? "n/a"}% over ${score.coveragePct}% coverage (${score.judgeable}/${score.totalWeight} weight judged)  manual pending: ${score.pendingManual.length}  defects: ${score.defects.length}`,
      );
      areaScores.push(score);
    } catch (err: any) {
      // A failed judge call must not lose earlier areas: score everything in
      // this area cannot_judge (routes to the manual queue) and continue.
      console.error(`  judge failed for ${spec.area}: ${err?.message ?? err}`);
      const judgement = {
        area: spec.area,
        items: spec.rubric
          .filter((r) => r.testability !== "manual")
          .map((r) => ({
            id: r.id,
            verdict: "cannot_judge" as const,
            confidence: "low" as const,
            reasoning: `Judge call failed: ${err?.message ?? err}. Verify manually or re-run this area.`,
            evidence_refs: [],
          })),
        defects: [],
        area_notes: "Judge call failed — all items routed to the manual queue.",
      };
      areaScores.push(scoreArea(spec, judgement, evidence));
    }
    writeArtifacts();
  }

  // Resuming with a narrower --areas selection must not delete areas the run
  // already scored: carry forward any prior area this pass didn't cover.
  for (const [area, prior] of priorAreas) {
    if (!areaScores.some((a) => a.area === area)) {
      log(`  carrying forward previously scored area: ${area} (${prior.pct ?? "n/a"}%)`);
      areaScores.push(prior);
    }
  }
  areaScores.sort((a, b) => a.area.localeCompare(b.area));

  const report = writeArtifacts();
  if (report.scoreWithheld) {
    log(
      `\nSCORE WITHHELD — only ${report.overallCoveragePct}% of rubric weight was judged (need ${MIN_COVERAGE_PCT}%).` +
        `\n  Provisional over the judged subset only: ${report.overallPct ?? "n/a"}% — not comparable across submissions.` +
        `\n  Raise coverage by working manual-checklist.md then running finalize, or re-run with more turns / pre-authenticated personas.`,
    );
  } else {
    log(
      `\nOverall: ${report.overallPct ?? "n/a"}%  (coverage: ${report.overallCoveragePct}% of rubric weight judged)`,
    );
  }
  log(`Report:  ${path.join(runDir, "report.html")}`);
  log(`Manual:  ${path.join(runDir, "manual-checklist.md")} (${report.manualPending} item(s))`);
  closeLog();
}

main().catch((err) => {
  // Log the failure into run.log too, and point at the resume command — the
  // run directory already holds every completed scenario and area score.
  try {
    log(`FATAL: ${err?.message ?? String(err)}`);
    log(`Resume with: pnpm run eval -- --resume <run dir> [--config <file>]`);
    closeLog();
  } catch {}
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
