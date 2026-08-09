import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig, newRunDir, parseArgs, KIT_VERSION } from "./config.js";
import { loadFixtures, loadSpecs, selectSpecs } from "./specs.js";
import { runScenario } from "./agent.js";
import { judgeArea } from "./judge.js";
import { buildReport, scoreArea, writeHtmlReport, writeManualChecklist, finalizeReport } from "./report.js";
import type { AreaScore, ScenarioEvidence } from "./types.js";

const HELP = `sbek — SessionBoard Eval Kit v${KIT_VERSION}

Usage:
  npm run sbek -- <command> [flags]

Commands:
  list                         Show feature areas, scenarios, and rubric coverage
  run --url <url>              Evaluate a submission URL
      [--areas a,b,c]          Only these area slugs
      [--include-optional]     Include optional (extra-credit) areas
      [--config <file>]        Config file (default evalconfig.json)
      [--dry-run]              Validate specs + print the plan; no browser, no API calls
      [--headed]               Show the browser window
      [--agent-model <id>] [--judge-model <id>]
  finalize --run <dir>         Merge manual-results.json into the report and rescore

Environment:
  ANTHROPIC_API_KEY            required for 'run' (not for --dry-run / list / finalize)
`;

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

  if (args.command === "finalize") {
    const runDir = String(args.flags.run ?? "");
    if (!runDir) throw new Error("finalize requires --run <dir>");
    const specs = loadSpecs();
    const report = finalizeReport(runDir, specs);
    console.log(`Finalized. Overall: ${report.overallPct ?? "n/a"}%  (${report.manualPending} manual item(s) still pending)`);
    return;
  }

  if (args.command !== "run") {
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig(args);
  const specs = selectSpecs(loadSpecs(), config.areas, Boolean(config.includeOptional));
  const fixtures = loadFixtures();

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
  const runDir = newRunDir();
  console.log(`Run dir: ${runDir}`);
  const startedAt = new Date().toISOString();
  const areaScores: AreaScore[] = [];

  // Incremental persistence: after each area, write a partial report so a
  // crash or API failure late in the run never loses completed area scores.
  const writeArtifacts = () => {
    const report = buildReport({
      targetUrl: config.url,
      startedAt,
      models: { agent: config.agentModel!, judge: config.judgeModel! },
      areas: areaScores,
    });
    fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
    writeHtmlReport(runDir, report);
    writeManualChecklist(runDir, specs, report);
    return report;
  };

  for (const spec of specs) {
    console.log(`\n=== Area: ${spec.title} ===`);
    const evidence: ScenarioEvidence[] = [];

    for (const scenario of spec.scenarios) {
      if (scenario.requires_credentials && !config.credentials?.[scenario.persona]) {
        console.log(`  ~ ${scenario.id} skipped (needs '${scenario.persona}' credentials)`);
        evidence.push({
          scenarioId: scenario.id,
          scenarioName: scenario.name,
          outcome: "blocked",
          summary: `Skipped: requires credentials for persona '${scenario.persona}' which were not provided.`,
          observations: [],
          transcript: [],
          screenshots: [],
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          turns: 0,
        });
        continue;
      }
      console.log(`  > ${scenario.id}: ${scenario.name}`);
      const evidenceDir = path.join(runDir, scenario.id);
      fs.mkdirSync(evidenceDir, { recursive: true });
      const result = await runScenario({
        client,
        config,
        scenario,
        areaTitle: spec.title,
        fixtures,
        evidenceDir,
      });
      console.log(`    outcome: ${result.outcome} (${result.turns} turns, ${result.screenshots.length} screenshots)`);
      evidence.push(result);
      fs.writeFileSync(path.join(evidenceDir, "evidence.json"), JSON.stringify(result, null, 2));
    }

    console.log(`  judging ${spec.rubric.filter((r) => r.testability !== "manual").length} rubric item(s)...`);
    try {
      const judgement = await judgeArea({ client, config, spec, evidence, runDir });
      const score = scoreArea(spec, judgement, evidence);
      console.log(`  score: ${score.pct ?? "n/a"}%  manual pending: ${score.pendingManual.length}  defects: ${score.defects.length}`);
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

  const report = writeArtifacts();
  console.log(`\nOverall: ${report.overallPct ?? "n/a"}%`);
  console.log(`Report:  ${path.join(runDir, "report.html")}`);
  console.log(`Manual:  ${path.join(runDir, "manual-checklist.md")} (${report.manualPending} item(s))`);
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
