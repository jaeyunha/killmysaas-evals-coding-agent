/**
 * Offline smoke test of the Playwright browser layer — no API key needed.
 * Verifies: navigate, ref tagging, fill, select, file upload, click,
 * confirmation detection, and screenshot capture against a local page.
 *
 *   npm run smoke
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { BrowserSession } from "../src/browser.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), "sbek-smoke-"));

const targetUrl = "file://" + path.join(here, "smoke.html");
// Same origin computation the harness uses (file:// origins resolve to "null").
const b = new BrowserSession(evidence, true, new URL(targetUrl).origin);
await b.start();

try {
  const snap1 = await b.navigate(targetUrl);

  const titleRef = snap1.match(/\[(e\d+)\] <input[^>]*> Your talk title/)?.[1];
  const selectRef = snap1.match(/\[(e\d+)\] <select/)?.[1];
  const fileRef = snap1.match(/\[(e\d+)\] <input type=file/)?.[1];
  const btnRef = snap1.match(/\[(e\d+)\] <button[^>]*> Submit proposal/)?.[1];
  if (!titleRef || !selectRef || !fileRef || !btnRef) {
    console.error(snap1);
    throw new Error("ref extraction failed — snapshot format changed?");
  }

  console.log(await b.fill(titleRef, "Taming 40-Minute CI"));
  console.log(await b.select(selectRef, "AI Engineering"));
  console.log(await b.upload(fileRef, path.resolve(here, "..", "fixtures", "slides.pdf")));
  await b.click(btnRef);

  const after = await b.snapshot();
  const confirmed = after.includes("Submission received: Taming 40-Minute CI");
  const shot = await b.screenshot("smoke-final", false);
  console.log(`screenshot: ${shot.relPath} (${shot.base64.length} b64 chars)`);
  if (!confirmed) throw new Error("confirmation text not found in snapshot");
  console.log("SMOKE OK: navigate/fill/select/upload/click/screenshot all worked; confirmation detected");
} finally {
  await b.stop();
  fs.rmSync(evidence, { recursive: true, force: true });
}
