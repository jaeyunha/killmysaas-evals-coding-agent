import assert from "node:assert/strict";
import test from "node:test";
import { JUDGE_SYSTEM, JudgementSchema, renderRubric } from "../src/judgement.js";

test("judgement schema and instructions support explicit not_applicable", () => {
  const parsed = JudgementSchema.parse({
    items: [
      {
        id: "ABS-14",
        verdict: "not_applicable",
        confidence: "high",
        reasoning: "No AI-assisted triage is claimed.",
        evidence_refs: ["obs: no AI claim"],
      },
    ],
    defects: [],
    area_notes: "",
  });
  assert.equal(parsed.items[0].verdict, "not_applicable");
  assert.match(JUDGE_SYSTEM, /not_applicable/);
  assert.match(JUDGE_SYSTEM, /only when the rubric item explicitly allows it/i);
  assert.match(JUDGE_SYSTEM, /accept semantically equivalent labels/i);

  const rendered = renderRubric([
    {
      id: "ABS-14",
      weight: 1,
      testability: "auto-partial",
      criterion: "AI behavior",
      pass_criteria: "works when claimed",
      not_applicable_when: "The clone makes no AI review claim.",
    },
    {
      id: "ABS-01",
      weight: 3,
      testability: "auto",
      criterion: "core behavior",
      pass_criteria: "works",
    },
  ]);
  assert.match(rendered, /ABS-14[\s\S]*not_applicable allowed when: The clone makes no AI review claim\./);
  assert.match(rendered, /ABS-01[\s\S]*not_applicable is not allowed/);
});
