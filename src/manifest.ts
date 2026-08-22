import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { EvalConfig, RunModels, Spec } from "./types.js";

export interface EvaluatorProvenance {
  sha: string | null;
  dirty: boolean;
  treeHash: string;
}

export interface RunManifest {
  schemaVersion: 2;
  createdAt: string;
  mode: "plan" | "run";
  evaluator: EvaluatorProvenance;
  candidate: { sha: string | null };
  workers: { apiVersionId: string | null; webVersionId: string | null };
  targetUrl: string;
  models: RunModels;
  plan: {
    areas: string[];
    scenarioIds: string[];
    scenarioCount: number;
    optionalAreasIncluded: boolean;
  };
}

const PROVENANCE_PATHS = [
  "--",
  ".",
  ":(exclude)runs/**",
  ":(exclude).sbek-current-run",
  ":(exclude).auth/**",
  ":(exclude).gjc/**",
  ":(exclude).DS_Store",
];

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Capture both the committed base and the exact evaluator source tree used.
 * The tree hash includes tracked and non-ignored untracked files, while
 * excluding run/auth/runtime artifacts that are not evaluator source.
 */
export function captureEvaluatorProvenance(root: string): EvaluatorProvenance {
  let sha: string | null = null;
  let dirty = true;
  const hash = createHash("sha256");
  hash.update("sbek-evaluator-tree-v1\0");

  try {
    sha = git(root, ["rev-parse", "HEAD"]).trim() || null;
    dirty = git(root, ["status", "--porcelain=v1", "--untracked-files=all", ...PROVENANCE_PATHS]).length > 0;
    const files = git(root, ["ls-files", "-co", "--exclude-standard", "-z", ...PROVENANCE_PATHS])
      .split("\0")
      .filter(Boolean)
      .sort();
    for (const relative of files) {
      const absolute = path.join(root, relative);
      hash.update(relative);
      hash.update("\0");
      if (!fs.existsSync(absolute)) {
        // `git ls-files` includes tracked paths deleted from the working tree.
        hash.update("deleted\0");
        continue;
      }
      const stat = fs.lstatSync(absolute);
      const kind = stat.isSymbolicLink() ? "link" : stat.mode & 0o111 ? "exec" : "file";
      const content = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(absolute)) : fs.readFileSync(absolute);
      hash.update(kind);
      hash.update("\0");
      hash.update(createHash("sha256").update(content).digest("hex"));
      hash.update("\0");
    }
  } catch {
    hash.update("git-provenance-unavailable");
  }

  return { sha, dirty, treeHash: hash.digest("hex") };
}

export function configuredModels(config: EvalConfig): RunModels {
  return {
    agent: config.agentModel ?? "unconfigured",
    judge: config.judgeModel ?? "unconfigured",
    ...(config.agentReasoningEffort
      ? { agentReasoningEffort: config.agentReasoningEffort }
      : {}),
    ...(config.judgeReasoningEffort
      ? { judgeReasoningEffort: config.judgeReasoningEffort }
      : {}),
  };
}

export function readRunManifest(runDir: string): RunManifest | null {
  const file = path.join(runDir, "manifest.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as RunManifest;
}

export function modelsForReport(manifest: RunManifest | null, config: EvalConfig): RunModels {
  return manifest?.models ?? configuredModels(config);
}

/** Keep resumed API calls on the model configuration frozen at run creation. */
export function applyManifestModels(config: EvalConfig, manifest: RunManifest | null): void {
  if (!manifest) return;
  config.agentModel = manifest.models.agent;
  config.judgeModel = manifest.models.judge;
  config.agentReasoningEffort = manifest.models.agentReasoningEffort;
  config.judgeReasoningEffort = manifest.models.judgeReasoningEffort;
}

export function createRunManifest(opts: {
  mode: RunManifest["mode"];
  config: EvalConfig;
  specs: Spec[];
  evaluator: EvaluatorProvenance;
}): RunManifest {
  const wanted = opts.config.scenarios?.length ? new Set(opts.config.scenarios) : null;
  const scenarioIds = opts.specs.flatMap((spec) =>
    spec.scenarios.filter((scenario) => !wanted || wanted.has(scenario.id)).map((scenario) => scenario.id),
  );
  return {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    mode: opts.mode,
    evaluator: opts.evaluator,
    candidate: { sha: opts.config.candidateSha ?? null },
    workers: {
      apiVersionId: opts.config.workerVersions?.api ?? null,
      webVersionId: opts.config.workerVersions?.web ?? null,
    },
    targetUrl: opts.config.url,
    models: configuredModels(opts.config),
    plan: {
      areas: opts.specs.map((spec) => spec.area),
      scenarioIds,
      scenarioCount: scenarioIds.length,
      optionalAreasIncluded: opts.specs.some((spec) => Boolean(spec.optional)),
    },
  };
}

export function writeRunManifest(runDir: string, manifest: RunManifest): void {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const value = (input: string | null) => input ?? "not recorded";
  const model = (name: "agent" | "judge") => {
    const effort = name === "agent" ? manifest.models.agentReasoningEffort : manifest.models.judgeReasoningEffort;
    return `${manifest.models[name]}${effort ? ` (effort=${effort})` : ""}`;
  };
  const lines = [
    `[${manifest.createdAt}] ${manifest.mode === "plan" ? "Plan created" : "Run started"}`,
    `Target URL: ${manifest.targetUrl}`,
    `candidate SHA: ${value(manifest.candidate.sha)}`,
    `Evaluator SHA: ${value(manifest.evaluator.sha)} (${manifest.evaluator.dirty ? "dirty" : "clean"}, tree ${manifest.evaluator.treeHash})`,
    `API Worker version: ${value(manifest.workers.apiVersionId)}`,
    `Web Worker version: ${value(manifest.workers.webVersionId)}`,
    `Models: agent=${model("agent")}, judge=${model("judge")}`,
    `Plan: ${manifest.plan.scenarioCount} scenarios across ${manifest.plan.areas.length} areas (${manifest.plan.optionalAreasIncluded ? "optional areas included" : "core only"})`,
    `Scenarios: ${manifest.plan.scenarioIds.join(", ")}`,
    "",
  ];
  fs.writeFileSync(path.join(runDir, "run.log"), lines.join("\n"));
}
