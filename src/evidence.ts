/**
 * Reading and rendering evidence bundles from a run directory.
 *
 * The run directory is the interface between browsing and judging:
 *
 *   runs/<stamp>/<scenarioId>/evidence.json
 *   runs/<stamp>/<scenarioId>/screenshots/001-label.jpg
 *   runs/<stamp>/judgements/<area>.json
 *
 * Both judge paths read from here — the API judge (src/judge.ts) and the
 * harness judge (`sbek judge-brief`) — so they see the same evidence, selected
 * the same way.
 */
import fs from "node:fs";
import path from "node:path";
import type { ScenarioEvidence, Spec } from "./types.js";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "… (truncated)" : s);

export function evidencePath(runDir: string, scenarioId: string): string {
  return path.join(runDir, scenarioId, "evidence.json");
}

export function judgementPath(runDir: string, area: string): string {
  return path.join(runDir, "judgements", `${area}.json`);
}

/** Evidence for every scenario in an area; scenarios never run get a placeholder. */
export function loadAreaEvidence(runDir: string, spec: Spec): ScenarioEvidence[] {
  return spec.scenarios.map((sc) => {
    const file = evidencePath(runDir, sc.id);
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8")) as ScenarioEvidence;
    }
    const now = new Date().toISOString();
    return {
      scenarioId: sc.id,
      scenarioName: sc.name,
      outcome: "blocked",
      summary:
        "NOT RUN — no evidence.json on disk. No evidence was gathered; rubric items relying on this scenario cannot be judged.",
      observations: [],
      transcript: [],
      screenshots: [],
      startedAt: now,
      finishedAt: now,
      turns: 0,
    } satisfies ScenarioEvidence;
  });
}

export function renderEvidence(evidence: ScenarioEvidence[], attached: Set<string>): string {
  return evidence
    .map((ev) => {
      const transcript = ev.transcript
        .map((t) => `  [turn ${t.turn}] ${t.kind}${t.tool ? ` ${t.tool}` : ""}: ${t.detail}`)
        .join("\n");
      const shots = ev.screenshots
        .map((s) => {
          const full = `${ev.scenarioId}/${s.path}`;
          return `  - ${full}${attached.has(full) ? " (ATTACHED below)" : " (not attached — cite only if the transcript describes it)"}`;
        })
        .join("\n");
      return [
        `=== SCENARIO ${ev.scenarioId}: ${ev.scenarioName} ===`,
        `outcome: ${ev.outcome} (${ev.turns} turns)`,
        `final url: ${ev.finalUrl ?? "unknown"}`,
        `agent summary: ${ev.summary}`,
        `observations:`,
        ...(ev.observations.length ? ev.observations.map((o) => `  - obs: ${o}`) : ["  (none)"]),
        `screenshots taken:`,
        shots || "  (none)",
        `transcript:`,
        clip(transcript, 14_000),
      ].join("\n");
    })
    .join("\n\n");
}

/** Judge sees at most this many screenshots per area. */
export const MAX_JUDGE_IMAGES = 40;

/**
 * The Messages API rejects any image over 2000px on a side in a many-image
 * request, and one oversized image fails the WHOLE call — losing an entire
 * area's judgement. Captures are clamped at write time, but evidence from
 * older runs may not be, so screen it here too.
 */
const MAX_IMAGE_EDGE = 2000;

/** Width/height straight from the JPEG SOF header; null if unparseable. */
function jpegSize(file: string): { w: number; h: number } | null {
  try {
    const b = fs.readFileSync(file);
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      // SOF0-SOF15, excluding DHT(c4)/JPG(c8)/DAC(cc)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Allocate the image budget fairly across scenarios (round-robin from each
 * scenario's tail) so an image-heavy final scenario can't evict all evidence
 * from earlier ones. Missing files are dropped before the cap applies.
 */
export function selectScreenshots(
  evidence: ScenarioEvidence[],
  runDir: string,
): { label: string; abs: string }[] {
  let oversized = 0;
  const perScenario = evidence.map((ev) =>
    ev.screenshots
      .map((s) => ({
        label: `${ev.scenarioId}/${s.path}`,
        abs: path.join(runDir, ev.scenarioId, ...s.path.split("/")),
      }))
      .filter((s) => {
        if (!fs.existsSync(s.abs)) return false;
        const dim = jpegSize(s.abs);
        if (dim && (dim.w > MAX_IMAGE_EDGE || dim.h > MAX_IMAGE_EDGE)) {
          oversized++;
          return false; // one of these would 400 the entire judge call
        }
        return true;
      })
      .reverse(), // tail first: later shots usually show completed states
  );
  if (oversized > 0) {
    console.warn(
      `  note: ${oversized} screenshot(s) exceed ${MAX_IMAGE_EDGE}px and were withheld from the judge (older evidence; captures are clamped now)`,
    );
  }
  const picked: { label: string; abs: string }[] = [];
  for (let round = 0; picked.length < MAX_JUDGE_IMAGES; round++) {
    let took = false;
    for (const list of perScenario) {
      if (round < list.length && picked.length < MAX_JUDGE_IMAGES) {
        picked.push(list[round]);
        took = true;
      }
    }
    if (!took) break;
  }
  // Restore chronological-ish order (by scenario, then capture order).
  picked.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  return picked;
}
