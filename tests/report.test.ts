import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { finalizeReport, scoreArea } from "../src/report.js";
import type { AreaJudgement, Spec } from "../src/types.js";

const spec: Spec = {
  area: "abstract-management",
  title: "Abstract Management",
  prefix: "ABS",
  area_weight: 1,
  overview: "test",
  scenarios: [],
  rubric: [
    {
      id: "ABS-01",
      criterion: "core behavior",
      weight: 3,
      type: "crud",
      testability: "auto",
      pass_criteria: "works",
    },
    {
      id: "ABS-14",
      criterion: "conditional AI behavior",
      weight: 1,
      type: "depth",
      testability: "auto-partial",
      pass_criteria: "works when claimed",
      manual_instructions: "inspect rationale when applicable",
      not_applicable_when: "The clone makes no AI-assisted-review claim.",
    },
  ],
};

test("not_applicable removes a conditional item from scoring without reducing coverage", () => {
  const judgement: AreaJudgement = {
    area: spec.area,
    items: [
      {
        id: "ABS-01",
        verdict: "pass",
        confidence: "high",
        reasoning: "verified",
        evidence_refs: ["obs: verified"],
      },
      {
        id: "ABS-14",
        verdict: "not_applicable",
        confidence: "high",
        reasoning: "The clone makes no AI-review claim.",
        evidence_refs: ["obs: no AI claim"],
      },
    ],
    defects: [],
    area_notes: "",
  };

  const score = scoreArea(spec, judgement, []);
  assert.equal(score.earned, 3);
  assert.equal(score.judgeable, 3);
  assert.equal(score.totalWeight, 3);
  assert.equal(score.pct, 100);
  assert.equal(score.coveragePct, 100);
  assert.deepEqual(score.pendingManual, []);
  assert.deepEqual(score.byType.depth, {
    earned: 0,
    judgeable: 0,
    totalWeight: 0,
    pct: null,
    coveragePct: 0,
  });
});

test("not_applicable is rejected for rubric items without explicit eligibility", () => {
  const judgement: AreaJudgement = {
    area: spec.area,
    items: [
      {
        id: "ABS-01",
        verdict: "not_applicable",
        confidence: "high",
        reasoning: "incorrectly skipped",
        evidence_refs: [],
      },
    ],
    defects: [],
    area_notes: "",
  };

  assert.throws(
    () => scoreArea(spec, judgement, []),
    /ABS-01.*not_applicable.*not eligible/i,
  );
});

test("manual finalization rejects ineligible not_applicable verdicts", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbek-finalize-"));
  const judgement: AreaJudgement = { area: spec.area, items: [], defects: [], area_notes: "" };
  const area = scoreArea(spec, judgement, []);
  fs.writeFileSync(
    path.join(runDir, "report.json"),
    JSON.stringify({
      targetUrl: "https://candidate.test",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:00.000Z",
      kitVersion: "test",
      models: { agent: "agent", judge: "judge" },
      areas: [area],
      overallPct: null,
      overallCoveragePct: 0,
      byType: {},
      scoreWithheld: true,
      manualPending: area.pendingManual.length,
    }),
  );
  fs.writeFileSync(
    path.join(runDir, "manual-results.json"),
    JSON.stringify({ "ABS-01": { verdict: "not_applicable", notes: "incorrect" } }),
  );

  assert.throws(
    () => finalizeReport(runDir, [spec]),
    /ABS-01.*not_applicable.*not eligible/i,
  );
});

test("eligible manual not_applicable exclusion is derived safely and remains stable", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbek-finalize-eligible-"));
  const judgement: AreaJudgement = {
    area: spec.area,
    items: [
      {
        id: "ABS-01",
        verdict: "pass",
        confidence: "high",
        reasoning: "verified",
        evidence_refs: ["obs: verified"],
      },
      {
        id: "ABS-14",
        verdict: "pass",
        confidence: "medium",
        reasoning: "UI half observed",
        evidence_refs: ["obs: AI score"],
      },
    ],
    defects: [],
    area_notes: "",
  };
  const area = scoreArea(spec, judgement, []);
  fs.writeFileSync(
    path.join(runDir, "report.json"),
    JSON.stringify({
      targetUrl: "https://candidate.test",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:00.000Z",
      kitVersion: "test",
      models: { agent: "agent", judge: "judge" },
      areas: [area],
      overallPct: 100,
      overallCoveragePct: 100,
      byType: {},
      scoreWithheld: false,
      manualPending: 1,
    }),
  );
  fs.writeFileSync(
    path.join(runDir, "manual-results.json"),
    JSON.stringify({ "ABS-14": { verdict: "not_applicable", notes: "No AI claim." } }),
  );

  const finalized = finalizeReport(runDir, [spec]);
  assert.equal(finalized.areas[0].totalWeight, 3);
  assert.equal(finalized.areas[0].judgeable, 3);
  assert.equal(finalized.areas[0].earned, 3);
  assert.equal(finalized.areas[0].coveragePct, 100);
  assert.equal(finalized.manualPending, 0);

  fs.writeFileSync(path.join(runDir, "manual-results.json"), "{}\n");
  const repeated = finalizeReport(runDir, [spec]);
  assert.equal(repeated.areas[0].totalWeight, 3);
  assert.equal(repeated.areas[0].judgeable, 3);
  assert.equal(repeated.areas[0].earned, 3);
});

test("an area containing only not_applicable criteria has full coverage and no pending work", () => {
  const conditionalOnly: Spec = { ...spec, rubric: [spec.rubric[1]] };
  const judgement: AreaJudgement = {
    area: conditionalOnly.area,
    items: [
      {
        id: "ABS-14",
        verdict: "not_applicable",
        confidence: "high",
        reasoning: "The prerequisite is false.",
        evidence_refs: ["obs: no AI claim"],
      },
    ],
    defects: [],
    area_notes: "",
  };

  const score = scoreArea(conditionalOnly, judgement, []);
  assert.equal(score.totalWeight, 0);
  assert.equal(score.judgeable, 0);
  assert.equal(score.pct, null);
  assert.equal(score.coveragePct, 100);
  assert.deepEqual(score.pendingManual, []);
});
