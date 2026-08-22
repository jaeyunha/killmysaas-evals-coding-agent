import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

const root = path.resolve(import.meta.dirname, "..");

function readJson(relative: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
}

test("CFP fixture stays deterministic while clone scoring accepts equivalent labels", () => {
  const fixture = readJson("fixtures/sample-data.json");
  assert.deepEqual(fixture.cfp.conditional_fields, [
    {
      field: "workshop_prerequisites",
      label: "Workshop prerequisites",
      show_when: { field: "format", equals: "Workshop (120 min)" },
    },
  ]);

  const spec = parse(fs.readFileSync(path.join(root, "specs/01-call-for-papers.yaml"), "utf8"));
  const item = spec.rubric.find((entry: any) => entry.id === "CFP-02");
  assert.match(item.pass_criteria, /semantically equivalent/i);
  assert.doesNotMatch(item.pass_criteria, /configured exactly|do not substitute/i);
  assert.match(item.pass_criteria, /appears/);
  assert.match(item.pass_criteria, /disappears/);

  const scenario = spec.scenarios.find((entry: any) => entry.id === "CFP-S1");
  assert.match(scenario.steps, /format answer is "Workshop \(120 min\)"/);
  assert.match(scenario.steps, /switch to "Talk \(30 min\)"/);
});

test("abstract-management fixtures remain fresh and disjoint from CFP decisions", () => {
  const fixture = readJson("fixtures/sample-data.json");
  const cfpTitles = new Set(fixture.submissions.map((submission: any) => submission.title));
  const abstractTitles = fixture.abstract_management_submissions.map(
    (submission: any) => submission.title,
  );

  assert.equal(abstractTitles.length, 3);
  assert.equal(new Set(abstractTitles).size, abstractTitles.length);
  for (const title of abstractTitles) {
    assert.equal(cfpTitles.has(title), false, `ABS title overlaps a CFP decision target: ${title}`);
  }

  const spec = fs.readFileSync(path.join(root, "specs/02-abstract-management.yaml"), "utf8");
  const normalizedSpec = spec.replace(/\s+/g, " ");
  for (const title of abstractTitles) assert.match(normalizedSpec, new RegExp(title));
  assert.match(spec, /fresh ABS-specific submissions/i);
  assert.match(spec, /active, and undecided/i);
  assert.match(spec, /evaluator precondition failure/i);
  assert.doesNotMatch(spec, /may even carry\s+.*Rejected decision/is);
});

test("speaker CSV identities are distinct from every configured persona identity", () => {
  const fixture = readJson("fixtures/sample-data.json");
  const personaNames = new Set(
    Object.values(fixture.identities).map((identity: any) => identity.name.toLowerCase()),
  );
  const personaEmails = new Set(
    Object.values(fixture.identities).map((identity: any) => identity.email.toLowerCase()),
  );
  const rows = fs
    .readFileSync(path.join(root, "fixtures/speakers.csv"), "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const [name, email] = line.split(",", 3);
      return { name: name.toLowerCase(), email: email.toLowerCase() };
    });

  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(personaNames.has(row.name), false, `CSV name overlaps persona: ${row.name}`);
    assert.equal(personaEmails.has(row.email), false, `CSV email overlaps persona: ${row.email}`);
  }

  const spec = fs.readFileSync(path.join(root, "specs/03-speaker-management.yaml"), "utf8");
  assert.match(spec, /three distinct non-persona speakers/i);
  assert.match(spec, /Priya Raman remains the configured speaker persona/i);
});

function utcDateKeyForLocal(date: string, time: string, timeZone: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const localMilliseconds = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  let candidate = localMilliseconds;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(candidate))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    const wallMilliseconds = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
    );
    candidate = localMilliseconds - (wallMilliseconds - candidate);
  }
  return new Date(candidate).toISOString().slice(0, 10);
}

test("event fixture dates keep the three agenda days and the displayed end date aligned", () => {
  const fixture = readJson("fixtures/sample-data.json");
  const event = fixture.event;
  const dateRange = /^(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})$/.exec(event.dates);
  assert.ok(dateRange, `event.dates must be a start/end date pair, got: ${event.dates}`);
  const [, startDate, endDate] = dateRange;

  const agendaDays: string[] = [];
  for (
    let cursor = Date.parse(`${startDate}T00:00:00Z`);
    cursor <= Date.parse(`${endDate}T00:00:00Z`);
    cursor += 86_400_000
  ) {
    agendaDays.push(new Date(cursor).toISOString().slice(0, 10));
  }
  assert.deepEqual(agendaDays, ["2027-05-12", "2027-05-13", "2027-05-14"]);

  const agendaSpec = fs.readFileSync(path.join(root, "specs/05-ai-agenda.yaml"), "utf8");
  assert.match(agendaSpec, /May 12, 13, 14, 2027/);
  assert.match(agendaSpec, /2027-05-12 to 2027-05-14/);

  // The organizer event list renders stored instants in UTC while the agenda
  // builder renders local event days; the fixture's daily hours must keep both
  // surfaces on the same calendar end date.
  assert.equal(event.timezone, "America/Los_Angeles");
  assert.match(event.start_time, /^\d{2}:\d{2}$/);
  assert.match(event.end_time, /^\d{2}:\d{2}$/);
  assert.equal(utcDateKeyForLocal(startDate, event.start_time, event.timezone), startDate);
  assert.equal(utcDateKeyForLocal(endDate, event.end_time, event.timezone), endDate);

  const cfpSpec = fs.readFileSync(path.join(root, "specs/01-call-for-papers.yaml"), "utf8");
  assert.match(cfpSpec, /2027-05-12 to 2027-05-14/);
});
