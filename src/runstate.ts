/**
 * The "current run" pointer.
 *
 * In the harness path, browsing and judging happen in separate agent sessions —
 * often separate processes — so there is nothing in memory to carry the run
 * directory between them. This file on disk is that continuity: `sbek plan`
 * writes it, the MCP server appends evidence into it, and `sbek judge-brief` /
 * `sbek score` read it so no one has to paste a timestamp around.
 */
import fs from "node:fs";

export const CURRENT_RUN_FILE = ".sbek-current-run";

export function readCurrentRun(): string | null {
  try {
    const dir = fs.readFileSync(CURRENT_RUN_FILE, "utf8").trim();
    return dir && fs.existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

export function writeCurrentRun(runDir: string): void {
  fs.writeFileSync(CURRENT_RUN_FILE, runDir + "\n");
}

/** The run to operate on: an explicit --run flag, else the current run. */
export function resolveRunDir(flag?: string): string {
  const dir = flag || readCurrentRun();
  if (!dir) {
    throw new Error(
      `No run directory. Pass --run <dir>, or start one with: pnpm run sbek -- plan`,
    );
  }
  if (!fs.existsSync(dir)) throw new Error(`Run directory not found: ${dir}`);
  return dir;
}
