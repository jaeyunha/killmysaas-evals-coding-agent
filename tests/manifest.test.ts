import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  captureEvaluatorProvenance,
  createRunManifest,
  modelsForReport,
  writeRunManifest,
} from "../src/manifest.js";
import { loadSpecs, selectSpecs } from "../src/specs.js";
import type { EvalConfig } from "../src/types.js";

const config: EvalConfig = {
  url: "https://candidate.example.test",
  candidateSha: "abc1234",
  workerVersions: { api: "api-worker-v17", web: "web-worker-v23" },
  agentModel: "claude-sonnet-5",
  judgeModel: "claude-opus-5",
  agentReasoningEffort: "medium",
  judgeReasoningEffort: "high",
  credentials: { organizer: { email: "secret@example.test", password: "do-not-store" } },
  personaEmails: { speaker: "private@example.test" },
};

test("core plan remains 18 scenarios and CRM is opt-in", () => {
  const specs = loadSpecs();
  const core = selectSpecs(specs, undefined, false);
  const withOptional = selectSpecs(specs, undefined, true);
  assert.equal(core.flatMap((spec) => spec.scenarios).length, 18);
  assert.equal(core.some((spec) => spec.area === "speaker-crm"), false);
  assert.equal(withOptional.flatMap((spec) => spec.scenarios).length, 20);
  assert.equal(withOptional.some((spec) => spec.area === "speaker-crm"), true);
});

test("run manifest records provenance, model effort, and plan without credentials", () => {
  const specs = selectSpecs(loadSpecs(), undefined, false);
  const manifest = createRunManifest({
    mode: "plan",
    config,
    specs,
    evaluator: { sha: "eval5678", dirty: true, treeHash: "tree1234" },
  });
  assert.equal(manifest.candidate.sha, "abc1234");
  assert.deepEqual(manifest.workers, {
    apiVersionId: "api-worker-v17",
    webVersionId: "web-worker-v23",
  });
  assert.equal(manifest.targetUrl, config.url);
  assert.deepEqual(manifest.evaluator, {
    sha: "eval5678",
    dirty: true,
    treeHash: "tree1234",
  });
  assert.deepEqual(manifest.models, {
    agent: "claude-sonnet-5",
    judge: "claude-opus-5",
    agentReasoningEffort: "medium",
    judgeReasoningEffort: "high",
  });
  assert.equal(manifest.plan.scenarioCount, 18);
  assert.equal(manifest.plan.optionalAreasIncluded, false);
  assert.equal(JSON.stringify(manifest).includes("do-not-store"), false);
  assert.equal(JSON.stringify(manifest).includes("secret@example.test"), false);
  assert.equal(JSON.stringify(manifest).includes("private@example.test"), false);
});

test("writeRunManifest writes manifest.json and an honest provenance log", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbek-manifest-"));
  const specs = selectSpecs(loadSpecs(), undefined, false);
  const manifest = createRunManifest({
    mode: "plan",
    config,
    specs,
    evaluator: { sha: "eval5678", dirty: false, treeHash: "tree1234" },
  });
  writeRunManifest(runDir, manifest);

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8")), manifest);
  const log = fs.readFileSync(path.join(runDir, "run.log"), "utf8");
  assert.match(log, /candidate SHA: abc1234/);
  assert.match(log, /API Worker version: api-worker-v17/);
  assert.match(log, /Evaluator SHA: eval5678 \(clean, tree tree1234\)/);
  assert.match(log, /agent=claude-sonnet-5 \(effort=medium\)/);
  assert.match(log, /judge=claude-opus-5 \(effort=high\)/);
  assert.match(log, /18 scenarios/);
  assert.doesNotMatch(log, /do-not-store|secret@example\.test|private@example\.test/);
});

test("report models are loaded from the frozen run manifest, not config defaults", () => {
  const specs = selectSpecs(loadSpecs(), undefined, false);
  const manifest = createRunManifest({
    mode: "plan",
    config,
    specs,
    evaluator: { sha: "eval5678", dirty: false, treeHash: "tree1234" },
  });
  assert.deepEqual(
    modelsForReport(manifest, {
      ...config,
      agentModel: "claude-opus-5",
      judgeModel: "claude-opus-5",
      agentReasoningEffort: undefined,
      judgeReasoningEffort: undefined,
    }),
    manifest.models,
  );
});

test("evaluator provenance marks dirty source and hashes working-tree content deterministically", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sbek-provenance-"));
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "evaluator.ts"), "export const value = 1;\n");
  execFileSync("git", ["-C", repo, "add", "src/evaluator.ts"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);

  const clean = captureEvaluatorProvenance(repo);
  assert.equal(clean.dirty, false);
  assert.match(clean.sha ?? "", /^[0-9a-f]{40}$/);
  assert.match(clean.treeHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(captureEvaluatorProvenance(repo), clean);

  fs.writeFileSync(path.join(repo, "src", "evaluator.ts"), "export const value = 2;\n");
  const dirty = captureEvaluatorProvenance(repo);
  assert.equal(dirty.sha, clean.sha);
  assert.equal(dirty.dirty, true);
  assert.notEqual(dirty.treeHash, clean.treeHash);
  assert.deepEqual(captureEvaluatorProvenance(repo), dirty);
});
