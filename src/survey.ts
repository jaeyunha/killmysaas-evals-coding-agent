/**
 * `survey` — the cheap existence check.
 *
 * The grading pipeline answers "does this work, with evidence a skeptic would
 * accept", which costs a real browsing run plus a vision judge. Survey answers
 * the much smaller question "is this capability here at all", which is
 * answerable from navigation labels and URLs alone. No screenshots, no
 * accessibility trees, no judge — the output is a triage map telling you which
 * areas are worth spending a real run on, and it catches a dead submission URL
 * in seconds instead of after a full run.
 *
 * It is deliberately NOT a score. A nav link named "Agenda" proves an entry
 * point exists, not that scheduling works.
 *
 * Driven by the agent-browser CLI rather than the Playwright layer in
 * browser.ts: this needs link labels and hrefs, not refs, containment, or
 * screenshots, and shelling out keeps the crawl's token cost off the agent's
 * context entirely — the agent sees only the final summary.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { authStatePath } from "./auth.js";
import type { Spec } from "./types.js";

const run = promisify(execFile);

/** Session name for the survey browser. Stable so repeat runs reuse the daemon. */
const SESSION = "sbek-survey";

/** Pages to open beyond the root. A survey that crawls deeply is a slow run. */
const DEFAULT_MAX_PAGES = 12;

/** Routes worth probing when navigation does not reveal them on its own. */
const CANDIDATE_ROUTES = ["/dashboard", "/admin", "/organizer", "/events", "/settings"];

/** Matches agent-browser's snapshot lines: `- link "Name" [ref=e3, url=...]`. */
const ENTRY_RE = /^\s*-\s+(\S+)\s+"([^"]*)"(?:\s+\[([^\]]*)\])?/;

export interface SurveyMatch {
  term: string;
  /** The nav label or URL that matched. */
  label: string;
  url?: string;
  /** "label" when a control's text matched, "url" when a path segment did. */
  via: "label" | "url";
}

export interface SurveyArea {
  area: string;
  title: string;
  found: boolean;
  matches: SurveyMatch[];
}

export interface SurveyResult {
  generatedAt: string;
  url: string;
  persona: string | null;
  /** False when the crawl was bounced to a login wall — every result is then public-only. */
  authenticated: boolean;
  pagesVisited: string[];
  areas: SurveyArea[];
  notes: string[];
}

interface Entry {
  role: string;
  name: string;
  url?: string;
  /** Page the entry was harvested from. */
  from: string;
}

async function ab(args: string[]): Promise<string> {
  try {
    const { stdout } = await run("agent-browser", args, {
      timeout: 45_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (err: any) {
    // A page that 404s or a nav that dies should cost this area a match, not
    // abort the survey — the whole point is a cheap best-effort map.
    return typeof err?.stdout === "string" ? err.stdout : "";
  }
}

/** Last line of agent-browser's output, which is where single-value results land. */
function lastLine(out: string): string {
  return out.trim().split("\n").pop()?.trim() ?? "";
}

/**
 * `open` returns as soon as the navigation is dispatched, so a cold browser
 * still reports `about:blank` and a warm one still reports the previous page.
 * Poll until the URL actually changes — without this the first harvest scrapes
 * a blank page and the whole crawl comes back empty.
 */
async function openAndSettle(base: string[], url: string, previous?: string): Promise<string> {
  const out = await ab([...base, "open", url]);

  // `open` echoes the page it landed on, and that is the more reliable source:
  // right after a cold launch the daemon still reports `get url` as about:blank
  // for a while, even though the navigation already succeeded.
  const echoed = /^\s*(https?:\/\/\S+)\s*$/m.exec(out)?.[1];
  if (echoed && !isDeadLoad(echoed)) return echoed;

  let current = "";
  for (let i = 0; i < 20; i++) {
    current = lastLine(await ab([...base, "get", "url"]));
    if (current && !isDeadLoad(current) && current !== previous) return current;
    await ab([...base, "wait", "250"]);
  }
  return current || url;
}

/**
 * A page that never loaded. Distinguishing this from "loaded, but the feature
 * is missing" matters more here than anywhere else in the kit: a survey that
 * silently reports every area absent because the dev server is down is worse
 * than no survey at all.
 */
function isDeadLoad(url: string): boolean {
  return !url || url === "about:blank" || url.startsWith("chrome-error:");
}

function parseSnapshot(text: string, from: string): Entry[] {
  const out: Entry[] = [];
  for (const line of text.split("\n")) {
    const m = ENTRY_RE.exec(line);
    if (!m) continue;
    const [, role, name, attrs = ""] = m;
    if (!name.trim()) continue;
    const url = /url=([^,\]]+)/.exec(attrs)?.[1]?.trim();
    out.push({ role, name: name.trim(), url, from });
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function looksLikeLogin(url: string): boolean {
  return /\/(login|signin|sign-in|sign_in|auth|register)\b/i.test(url);
}

/**
 * Term matching is intentionally loose — plural and possessive forms of the
 * same label should count, because a clone naming its section "Reviews" has
 * the capability the spec calls "Review". False positives are visible (the
 * matched label is recorded next to the verdict) and cost the user a glance;
 * false negatives would send them into a full run to find out.
 */
function matchTerm(term: string, entries: Entry[], visited: string[]): SurveyMatch | null {
  const t = norm(term);
  if (t.length < 3) return null;

  // Rank candidates rather than taking the first hit: a nav link named exactly
  // "Call for proposals" is far better evidence than a data row that happens to
  // read "Untitled CFP", and the report shows only the top match per term.
  let best: { rank: number; e: Entry } | null = null;
  for (const e of entries) {
    const n = norm(e.name);
    let rank = -1;
    if (n === t) rank = 0;
    else if (n.startsWith(t + " ") || n.endsWith(" " + t) || n.includes(" " + t + " ")) rank = 1;
    // Stem both directions: "review" should hit "reviews"/"reviewers", and the
    // term "Files" should hit a nav item named "File requests".
    else if (
      n.split(" ").some((w) => {
        const [long, short] = w.length >= t.length ? [w, t] : [t, w];
        return long.startsWith(short) && long.length - short.length <= 3 && short.length >= 4;
      })
    )
      rank = 2;
    if (rank < 0) continue;
    // Long labels are stat cards and table rows; short ones are navigation.
    if (!best || rank < best.rank || (rank === best.rank && e.name.length < best.e.name.length)) {
      best = { rank, e };
    }
  }
  if (best) return { term, label: best.e.name, url: best.e.url, via: "label" };

  const s = slug(term);
  const compact = s.replace(/-/g, "");
  const urls = [...visited, ...entries.map((e) => e.url ?? "")].filter(Boolean);
  for (const u of urls) {
    const segs = u.split(/[/?#]/).filter(Boolean).map((x) => x.toLowerCase());
    if (segs.some((seg) => seg === s || seg === compact || seg.replace(/-/g, "") === compact)) {
      return { term, label: u, url: u, via: "url" };
    }
  }
  return null;
}

export async function survey(opts: {
  url: string;
  specs: Spec[];
  persona?: string;
  maxPages?: number;
}): Promise<SurveyResult> {
  const { url, specs } = opts;
  const persona = opts.persona ?? "organizer";
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const notes: string[] = [];

  const statePath = authStatePath(persona, url);
  const hasState = fs.existsSync(statePath);
  if (!hasState) {
    notes.push(
      `No saved session at ${statePath} — surveying logged out, so organizer-only areas will look absent. ` +
        `Fix with: npx --no-install tsx src/cli.ts auth --persona ${persona}`,
    );
  }

  const origin = new URL(url).origin;
  const base = ["--session", SESSION];

  // Fresh browser per survey: a stale session from a previous submission would
  // silently answer for the wrong app.
  await ab([...base, "close"]);

  // `--state` configures a *running* browser — on a cold session it fails with
  // "Could not connect" and silently leaves you logged out. So always warm the
  // browser with a plain open first, then apply the session and navigate again.
  const warm = await openAndSettle(base, url);
  const landed = hasState ? await openAndSettle([...base, "--state", statePath], url) : warm;
  if (isDeadLoad(landed)) {
    await ab([...base, "close"]);
    throw new Error(
      `${url} did not load (browser ended on "${landed || "nothing"}").\n` +
        `The site is unreachable, not featureless — reporting every area absent here would be a lie.\n` +
        `Check the server is up, then re-run.`,
    );
  }
  const authenticated = hasState && !looksLikeLogin(landed);
  if (hasState && !authenticated) {
    notes.push(
      `Saved session did not hold — the app bounced to ${landed}. Results below are public-only. Re-run auth for "${persona}".`,
    );
  }

  const entries: Entry[] = [];
  const visited: string[] = [];
  const queue: string[] = [];

  const harvest = async (pageUrl: string) => {
    const text = await ab([...base, "snapshot", "-i", "-u"]);
    const found = parseSnapshot(text, pageUrl);
    entries.push(...found);
    for (const e of found) {
      if (!e.url || !e.url.startsWith(origin)) continue;
      const clean = e.url.split("#")[0];
      if (!visited.includes(clean) && !queue.includes(clean)) queue.push(clean);
    }
  };

  visited.push(landed);
  await harvest(landed);

  // Nav rarely exposes every module; probe the conventional admin roots too.
  for (const r of CANDIDATE_ROUTES) {
    const candidate = new URL(r, origin).toString();
    if (!visited.includes(candidate) && !queue.includes(candidate)) queue.push(candidate);
  }

  let at = landed;
  while (queue.length && visited.length < maxPages) {
    const next = queue.shift()!;
    if (visited.includes(next)) continue;
    at = await openAndSettle(base, next, at);
    // A login wall teaches us nothing about features; a dead load, less than that.
    if (looksLikeLogin(at) || isDeadLoad(at)) continue;
    visited.push(next);
    await harvest(next);
  }

  await ab([...base, "close"]);

  const areas: SurveyArea[] = specs.map((s) => {
    const terms = s.survey_terms ?? [s.title];
    const matches: SurveyMatch[] = [];
    for (const term of terms) {
      const m = matchTerm(term, entries, visited);
      if (m && !matches.some((x) => x.label === m.label)) matches.push(m);
    }
    // Strongest evidence first — the report truncates, so a real nav link must
    // not be crowded out by an incidental text match on a dashboard tile.
    matches.sort((a, b) => {
      if (a.via !== b.via) return a.via === "label" ? -1 : 1;
      return a.label.length - b.label.length;
    });
    return {
      area: s.area,
      title: s.title,
      found: matches.length > 0,
      matches: matches.slice(0, 5),
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    url,
    persona: hasState ? persona : null,
    authenticated,
    pagesVisited: visited,
    areas,
    notes,
  };
}

export function writeSurvey(runDir: string, result: SurveyResult): string {
  fs.mkdirSync(runDir, { recursive: true });
  const file = path.join(runDir, "survey.json");
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
  return file;
}

export function renderSurvey(result: SurveyResult): string {
  const lines: string[] = [];
  lines.push(`Target: ${result.url}`);
  lines.push(
    `Session: ${result.persona ?? "none (logged out)"}${result.authenticated ? " — authenticated" : ""}`,
  );
  lines.push(`Pages visited: ${result.pagesVisited.length}\n`);

  for (const a of result.areas) {
    const mark = a.found ? "found    " : "NOT FOUND";
    lines.push(`  ${mark}  ${a.title} (${a.area})`);
    for (const m of a.matches) {
      const where = m.via === "url" ? m.url ?? "" : m.url ? `  ->  ${m.url}` : "";
      lines.push(`             "${m.label}"${m.via === "url" ? "" : ""}${where}`);
    }
  }

  const missing = result.areas.filter((a) => !a.found);
  lines.push(
    `\n${result.areas.length - missing.length}/${result.areas.length} areas have an entry point.`,
  );
  if (missing.length) {
    lines.push(`Absent: ${missing.map((a) => a.area).join(", ")}`);
  }
  for (const n of result.notes) lines.push(`\nNote: ${n}`);
  lines.push(
    `\nThis is presence only — a nav link proves an entry point exists, not that the`,
    `feature works. Grade with: plan -> browse -> judge-brief -> score.`,
  );
  return lines.join("\n");
}
