# AGENTS.md — running `sbek` from inside a coding agent

This repo grades third-party clones of SessionBoard (event call-for-papers /
speaker & session management). You can run the whole evaluation yourself, with
no Anthropic API key: **you** are the browser agent and **you** are the judge.

The same workflow is packaged as two skills in `.agents/skills/`:

| skill | what it does |
|---|---|
| `.agents/skills/sbek-browse/SKILL.md` | phase 1 — drive the browser, gather evidence |
| `.agents/skills/sbek-judge/SKILL.md` | phases 2–3 — read the evidence, judge, score |

`.claude/skills/` symlinks to them so Claude Code discovers them without a second
copy; point any other agent at `.agents/skills/` directly.

The MCP command lives in `.mcp.json`.

## Setup

Run these yourself; ask the user only for what you cannot determine. Check
`evalconfig.json` first — if it already has a `url`, use it without asking.

```bash
pnpm install                                  # also downloads Playwright Chromium
cp evalconfig.example.json evalconfig.json    # set "url" to the submission
```

`evalconfig.example.json` documents `credentials`, `personaEmails`, and
`submissionNotes`; fill in whatever the user gave you and leave the rest.

Authentication is the one step you cannot do — it opens a real browser window a
human must log into. For any persona with no session in `.auth/` and no
`credentials` entry, hand the user:

```bash
pnpm run sbek -- auth --persona organizer     # per persona
```

Magic links must be pasted into *that* window's address bar. You may proceed
without it, but those scenarios often end `blocked` — say so rather than
silently producing weak evidence.

Register the MCP server with your client (stdio):

```
command: pnpm
args:    ["--silent", "exec", "tsx", "src/mcp.ts"]
cwd:     this repo
```

## Phase 0 — survey (optional, cheap)

Before spending a real run, ask the small question: does each area exist at all?

```bash
pnpm run sbek -- survey --url https://submission.example.com --persona organizer
```

Drives `agent-browser` in a subprocess to crawl navigation one level deep and
match link labels and URL segments against each area's `survey_terms`. It signs
in with the session saved by `sbek auth` when there is one — without it you are
surveying logged out and every organizer-only area will read absent, which the
output says explicitly. Writes `runs/<stamp>/survey.json`.

Almost none of this reaches your context: the crawl output stays in the
subprocess and you see only a per-area table. No screenshots, no accessibility
trees, no judge.

**A survey is not a score.** `found` means an entry point with the right name
exists, nothing more — a nav link named "Agenda" proves neither that scheduling
works nor that it is any good. Never report survey results as an evaluation, and
never let them stand in for a rubric verdict. Use it to triage which areas
deserve a run, and to catch a dead URL or an expired session in seconds.

## Phase 1 — browse

```bash
pnpm run sbek -- plan --url https://submission.example.com
```

Creates the run directory, records it in `.sbek-current-run`, and prints the
scenario checklist. Re-run it any time to see what still lacks evidence.

For each unfinished scenario:

1. `start_scenario({ scenario_id: "CFP-S1" })` — opens the browser, restores the
   persona's session, and **returns your full brief**: ground rules, the script,
   the persona, the sample data. That brief is the real instruction set; follow
   it over anything in this file.
2. `snapshot` to see what is actionable, then `click` / `fill` / `select` /
   `press` / `scroll` / `drag` / `upload` by `ref`. **Refs are stable for the
   whole scenario**, so actions return only the URL and what newly appeared —
   keep using refs you already have, and snapshot again only for the page
   outline or when a ref reports as stale.
3. `screenshot({ label })` at every meaningful state and `observe({ note })` for
   every factual finding. The judge sees only this evidence, never your
   reasoning. A scenario with no screenshots is worthless.
4. `done({ outcome, summary })` with `completed`, `blocked`, or
   `feature_not_found`. This writes `evidence.json` and closes the browser; you
   cannot start the next scenario until you do.

Budget roughly 70 tool calls per scenario. Rules worth repeating:

- **Judge function, not appearance.** These are clones. "Call for Papers" may be
  "Submissions" or "Apply to speak". Look for the equivalent before concluding
  anything is missing.
- **A missing capability is a finding, not a blocker.** Record an observation
  naming what is missing and what you tried, then keep going with whatever data
  exists so the rest of the scenario still yields evidence.
- **Reserve `blocked`** for genuinely unreachable capability — a hard auth wall,
  a crash, a flow that does not exist.
- **Never enter real personal data, payment details, or credentials** other than
  the test values in the brief.
- Stepped wizards unlock as you advance; a "disabled" later step is not a
  missing feature. An overlay covering a control means dismiss the overlay, not
  that the control is broken.
- `abort_scenario` throws a wedged session away without writing evidence. Do not
  use it to skip hard scenarios — those end with `done({ outcome: "blocked" })`.
- If a pre-authenticated run hits a login wall twice, the server halts the
  scenario deliberately: everything past that point would be observed logged out
  and would report real features as missing. Re-run `sbek auth` and retry.

## Phase 2 — judge

**Start a fresh session, or dispatch one subagent per area.** An agent that just
browsed the app knows what it *intended* to accomplish; that memory contaminates
the verdicts.

Resolve the run directory from `.sbek-current-run`; if that is missing and
several `runs/*/` exist, ask which one. Then judge every area that has evidence
— the run directory already tells you which, so do not ask.

```bash
pnpm run sbek -- judge-brief --area call-for-papers   # add --run runs/<stamp> if not current
```

Prints the judging rules, the rubric, the rendered evidence, and the absolute
paths of the selected screenshots. **Read every one of those images** — the
transcript records what was attempted, the screenshots show what rendered.

Write `runs/<stamp>/judgements/<area>.json`, one item per non-manual rubric id:

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

Verdicts: `pass` (clearly satisfied) · `partial` (works, with a gap you name) ·
`fail` (attempted and broken) · `not_found` (searched for, appears absent) ·
`cannot_judge` (evidence cannot decide — do not guess).

The distinction that matters most is **`not_found` (the clone lacks it)** vs
**`cannot_judge` (the agent never got there)**. A `blocked` scenario usually
means `cannot_judge` for everything downstream. Scoring a feature absent because
the run died is the most damaging mistake available here.

Be strict about `pass`: a form existing is not proof submission works — look for
confirmation states, persisted data, the record showing up in a list. And
`defects` describe the *application*, never the run: turn limits, a lost agent,
or missing evidence belong in `area_notes`.

## Phase 3 — score

```bash
pnpm run sbek -- score
```

Validates every judgement against the schema and writes `report.json`,
`report.html`, and `manual-checklist.md`. Unjudged areas count as
`cannot_judge` rather than vanishing, so coverage tells the truth. Below 60% of
rubric weight judged the headline score is withheld — a percentage over part of
a rubric is not comparable between submissions.

Manual items (emails actually arriving, calendar exports, second-account
visibility) go to `manual-checklist.md`; a human fills `manual-results.json`,
then `pnpm run sbek -- finalize --run runs/<stamp>` folds them in.

## Repo orientation

| Path | What it is |
|---|---|
| `specs/*.yaml` | the rubrics and scenario scripts — the source of truth for what is graded |
| `docs/` | what each feature area is supposed to do; rubric ids trace back here |
| `src/mcp.ts` | the MCP server you drive; holds one browser open across tool calls |
| `src/browser.ts` | the Playwright layer: snapshots, refs, containment, screenshots |
| `src/brief.ts`, `src/tools.ts` | prompts and tool definitions shared by both drive paths |
| `src/evidence.ts`, `src/judgement.ts` | the run-directory contract and judge schema |
| `src/cli.ts` | `list` / `survey` / `plan` / `judge-brief` / `score` / `auth` / `rescore` / `finalize` / `run` |
| `src/survey.ts` | Phase 0 presence check: agent-browser crawl, `survey_terms` matching |
| `src/agent.ts`, `src/judge.ts` | the API path — only these two call Anthropic |

Run `pnpm typecheck` after changing anything under `src/`.
