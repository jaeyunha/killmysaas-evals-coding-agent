---
name: sbek-judge
description: Grade a completed sbek run — read the evidence and screenshots, write per-area judgements, and produce the score report. Use after browsing scenarios, or when asked to judge, grade, or score a SessionBoard eval run (no API key needed).
---

# Judging a SessionBoard eval run

You are the judge. There is no sub-model: you read the evidence yourself and
your verdicts are the score.

**Run the commands in this file yourself.** Ask the user only for what you
cannot determine from the run directory.

Commands use `npx --no-install`, which works anywhere Node is installed. If
`pnpm` is on your PATH, `pnpm run sbek -- <cmd>` is equivalent.

**Judge in a fresh context.** If you personally browsed these scenarios in this
session, stop — you remember what you *meant* to accomplish, and that memory
turns "I tried to submit a talk" into "submission works". Start a new session, or
dispatch one subagent per area if your agent supports it.

## 1. Find the run

```bash
cat .sbek-current-run 2>/dev/null; ls -d runs/*/ 2>/dev/null | tail -5
```

Use `.sbek-current-run` if it exists — that is the run just browsed. If it is
missing and there are several run directories, ask the user which one, listing
them newest first. If there is exactly one, use it.

Then see which areas have evidence and which are already judged:

```bash
ls runs/<stamp>/ runs/<stamp>/judgements/ 2>/dev/null
```

Judge every area that has scenario evidence. Do not ask which areas — the run
directory already says.

## 2. Per area

```bash
npx --no-install tsx src/cli.ts judge-brief --area call-for-papers   # add --run runs/<stamp> if not current
```

That prints the judging rules, the rubric, the rendered evidence, and the
absolute paths of the selected screenshots.

**View every one of those screenshots.** The transcript says what was attempted;
the images say what actually rendered. Judging from the transcript alone is how a
broken page gets scored as working. If your agent cannot view images, say so
explicitly in `area_notes` and lower your confidence accordingly — do not
silently judge blind.

Then write `runs/<stamp>/judgements/<area>.json` — one item per non-manual
rubric id in the brief, no ids invented:

```json
{
  "items": [{
    "id": "CFP-R1",
    "verdict": "pass",
    "confidence": "high",
    "reasoning": "The submitted talk appears in the organizer's list with title and track.",
    "evidence_refs": ["CFP-S1/screenshots/007-list.jpg", "obs: confirmation banner shown", "turn 22"]
  }],
  "defects": [{ "severity": "major", "description": "...", "where": "/admin/sessions" }],
  "area_notes": "..."
}
```

Repeat for each area before scoring.

## 3. Score

```bash
npx --no-install tsx src/cli.ts score     # add --run runs/<stamp> if not current
```

Validates every judgement against the schema and writes `report.json`,
`report.html`, and `manual-checklist.md`. Tell the user where the report is and
summarize the headline result, the withheld-score situation if any, and the most
serious defects.

Manual items — emails actually arriving, calendar exports, what a second account
can see — cannot be judged from this evidence and land in
`manual-checklist.md`. A human fills `manual-results.json`, then
`npx --no-install tsx src/cli.ts finalize --run runs/<stamp>` folds them in.

## Verdicts

| verdict | when |
|---|---|
| `pass` | clearly satisfied by the evidence |
| `partial` | works, with a gap you name in `reasoning` |
| `fail` | attempted and demonstrably broken |
| `not_found` | searched for, appears absent from the app |
| `cannot_judge` | the evidence cannot decide — do not guess |

The distinction that matters most is **`not_found` (the clone lacks it)** vs
**`cannot_judge` (the run never got there)**. A `blocked` scenario usually means
`cannot_judge` for everything downstream. Marking a feature absent because the
run died is the most damaging mistake available here.

## Standards

- **Every item needs `evidence_refs`** pointing at a screenshot path, an
  observation, or a turn. A verdict you cannot anchor is `cannot_judge`.
- **Be strict about `pass`.** A form existing is not proof submission works. Look
  for confirmation states, persisted data, the record appearing in a list.
- **Judge function, not appearance.** These are clones; different labels for the
  same capability still pass.
- **`defects` describe the application, never the run.** Turn limits, a lost
  session, thin evidence — those go in `area_notes`.

## Coverage and withholding

Areas with no judgement file score as `cannot_judge` rather than disappearing,
so coverage stays honest. Below 60% of rubric weight judged, the headline score
is withheld: a percentage computed over part of a rubric is not comparable
across submissions. If you see that in the output, say so — the fix is more
evidence, not more generous verdicts.
