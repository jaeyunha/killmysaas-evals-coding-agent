---
name: sbek-browse
description: Run SessionBoard eval scenarios by driving a real browser yourself via the sbek MCP server. Use when asked to evaluate, test, or gather evidence on a submission URL, or when asked to run sbek scenarios in-session (no API key needed).
---

# Browsing scenarios for the SessionBoard Eval Kit

You are the browser agent. There is no sub-model and no API call: you call the
`sbek` MCP tools directly, and your own judgement of what to click is the eval.

**Run the commands in this file yourself.** Do not print them for the user to
run — the only step that genuinely needs a human is the interactive login in
step 2, and that one is clearly marked.

Commands here use `npx --no-install`, which works anywhere Node is installed. If
`pnpm` is on your PATH, `pnpm run sbek -- <cmd>` is equivalent.

## 1. Set up (do this before asking the user anything)

Check what already exists, so you only ask for what is actually missing:

```bash
cat evalconfig.json 2>/dev/null; ls .auth/ 2>/dev/null; ls node_modules >/dev/null 2>&1 || echo NEED_INSTALL
```

- If `NEED_INSTALL`, run `npm install` (or `pnpm install`) — it also downloads
  Playwright Chromium, so give it a few minutes.
- If `evalconfig.json` has a `url`, **use it and do not ask**.
- If it is missing, ask the user for the submission URL, then write the config
  yourself:

```bash
cp evalconfig.example.json evalconfig.json
```

Set `url` in it. Read `evalconfig.example.json` first — it documents
`credentials`, `personaEmails`, and `submissionNotes`. Fill in whatever the user
gave you and leave the rest.

Ask about scope only if the user did not already say: all required areas (the
default), a single area, or a smoke test of one scenario. Do not ask about
anything you can determine yourself.

## 2. Authentication (the one human step)

Check which personas the selected scenarios need, then look at `.auth/`. For any
persona with no saved session and no `credentials` entry, ask the user to run
this **themselves** — it opens a real browser window they must log into:

```bash
npx --no-install tsx src/cli.ts auth --persona speaker
```

Magic links must be pasted into **that** window's address bar; a link opened in
their normal browser authenticates the wrong session. Scenarios for a captured
persona then start already signed in.

You may proceed without it — those scenarios will try to sign themselves up, and
often end `blocked`. Say so plainly rather than silently producing weak evidence.

## 3. Plan — run it

```bash
npx --no-install tsx src/cli.ts plan --url <url>    # add --areas a,b or --scenarios ID,ID
```

Creates the run directory, records it in `.sbek-current-run`, and prints the
scenario checklist. Re-run it any time to see what still lacks evidence; it is
idempotent and cheap.

Confirm the `sbek` MCP server is connected — you should see tools named
`start_scenario`, `snapshot`, `done`. If they are missing, the server is not
registered; `.mcp.json` in this repo has the stdio command, and the user must
add it to their agent's MCP config and restart the session.

## 4. Browse — this is the actual work

For each unfinished scenario, in order:

1. `start_scenario({ scenario_id: "CFP-S1" })` — opens the browser, restores the
   persona's session, and returns your full brief: ground rules, the script, the
   persona, the sample data. **Follow that brief; it is the real instruction
   set**, more specific than this file.
2. `snapshot` to see what is actionable, then `click` / `fill` / `select` /
   `press` / `scroll` / `drag` / `upload` by `ref`. Refs come from the most
   recent snapshot and are re-assigned each time, so snapshot again after
   anything that changes the page.
3. `screenshot({ label })` at every meaningful state and `observe({ note })` for
   every factual finding — especially a capability the app appears to lack, and
   what you tried before concluding that. The judge sees only this evidence,
   never your reasoning. A scenario with no screenshots is worthless.
4. `done({ outcome, summary })` — `completed`, `blocked`, or
   `feature_not_found`. Writes `evidence.json` and closes the browser. You
   cannot start the next scenario until you do.

Work through every scenario without stopping to check in between them. Report
progress as you go; only interrupt the user if something is genuinely blocked on
them (a login, an approval).

When `plan` shows every scenario `[done]`, **stop and hand off to judging** — see
the `sbek-judge` skill. Do not judge in this session: you have watched these
pages and know what you meant to do, and that is exactly the bias the judge must
not have. Start a fresh session, or dispatch one subagent per area if your agent
supports it.

## Rules that matter most

- **Judge function, not appearance.** These are clones. "Call for Papers" may be
  "Submissions" or "Apply to speak". Hunt for the equivalent before concluding
  something is missing.
- **A missing capability is a finding, not a blocker.** Record an observation
  naming what is missing and what you tried, then continue with whatever data
  exists so the rest of the scenario still produces evidence.
- **Reserve `blocked`** for a capability that is genuinely unreachable — a hard
  auth wall, a crash, a flow that does not exist. Not for sample data that does
  not match the app's seeded data.
- **Never enter real personal data, payment details, or credentials** other than
  the test values in the brief.
- **Budget roughly the configured turns per scenario** (default 70 tool calls).
  Spend them on rubric evidence, not on guessing URLs.

## When something goes wrong

- *"no scenario open"* — call `start_scenario` first.
- *Session lost* — if the run was pre-authenticated and the app bounces you to a
  login wall twice, the server halts the scenario as `blocked` on purpose:
  everything after that point would be observed logged out and would report real
  features as missing. Ask the user to re-run `auth` for that persona, then redo
  the scenario.
- *Wedged browser* — `abort_scenario` discards it with no `evidence.json`, then
  `start_scenario` again. Do not use it to skip a hard scenario; a scenario you
  genuinely could not do should end with `done({ outcome: "blocked" })` so the
  judge sees why.
- *A control is covered by an overlay* — dismiss the overlay and retry rather
  than concluding the control is broken.
- *A wizard step looks disabled* — stepped flows unlock as you advance. Press
  Next/Continue/Save instead of concluding the step is missing.
