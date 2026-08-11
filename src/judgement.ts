/**
 * The judge's output contract, shared by both judge paths.
 *
 * The API judge (src/judge.ts) hands this schema to structured output; the
 * harness judge writes the same shape to runs/<stamp>/judgements/<area>.json
 * by hand and `sbek score` validates it here. Same contract either way, so a
 * report cannot tell which path produced it.
 */
import { z } from "zod/v4";

export const JudgementSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      verdict: z.enum(["pass", "partial", "fail", "not_found", "cannot_judge"]),
      confidence: z.enum(["high", "medium", "low"]),
      reasoning: z.string(),
      evidence_refs: z.array(z.string()),
    }),
  ),
  defects: z.array(
    z.object({
      severity: z.enum(["critical", "major", "minor"]),
      description: z.string(),
      where: z.string(),
    }),
  ),
  area_notes: z.string(),
});

export type ParsedJudgement = z.infer<typeof JudgementSchema>;

export const JUDGE_SYSTEM = `You are an impartial software evaluator judging whether a web application implements specific functionality. The app is a third-party clone of SessionBoard (event call-for-papers / speaker & session management); it may look nothing like the original — judge FUNCTION against each criterion, never visual resemblance.

You receive: the rubric (criteria with pass conditions), and evidence gathered by a browser agent (scenario outcomes, its factual observations, an action transcript, and screenshots).

Rules:
- Judge ONLY from the evidence. Every verdict must cite specific evidence_refs: screenshot paths (e.g. "screenshots/003-cfp-form-filled.jpg") and/or observations/transcript turns (e.g. "obs: ...", "turn 12").
- pass: the criterion is clearly satisfied. partial: works but with a meaningful gap named in your reasoning. fail: attempted and broken/incorrect. not_found: the agent searched and the capability appears absent. cannot_judge: the evidence is insufficient to decide (e.g. the agent was blocked before reaching it) — do NOT guess.
- Distinguish "the clone lacks the feature" (not_found) from "the agent failed to reach it" (cannot_judge). Read the scenario outcome: 'blocked' or 'agent_error' usually means cannot_judge for downstream criteria.
- Be strict about evidence for 'pass': a form existing is not proof submission works; look for confirmation states, persisted data, list entries.
- Independently list defects you notice IN THE EVALUATED APPLICATION (broken flows, error states, data loss, misleading UI), even if no rubric item covers them. Defects describe the app, never the evaluation run: a turn limit, an agent that got lost, a harness error, or missing evidence is NOT a defect — that belongs in area_notes and in cannot_judge verdicts.
- Return a verdict for EVERY rubric item you were given, in the same order.`;

/** The rubric block the judge scores against. Identical for both judge paths. */
export function renderRubric(
  autoItems: {
    id: string;
    weight: number;
    testability: string;
    criterion: string;
    pass_criteria: string;
    evidence?: string;
  }[],
): string {
  return autoItems
    .map(
      (r) =>
        `- ${r.id} (weight ${r.weight}${r.testability === "auto-partial" ? ", auto-partial: judge only the UI-observable half" : ""}): ${r.criterion}\n  pass when: ${r.pass_criteria}${r.evidence ? `\n  look for: ${r.evidence}` : ""}`,
    )
    .join("\n");
}
