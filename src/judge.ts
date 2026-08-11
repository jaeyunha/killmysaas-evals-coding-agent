import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod/v4";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { AreaJudgement, EvalConfig, ScenarioEvidence, Spec } from "./types.js";
import { renderEvidence, selectScreenshots } from "./evidence.js";
import { JUDGE_SYSTEM, JudgementSchema, renderRubric } from "./judgement.js";

export async function judgeArea(opts: {
  client: Anthropic;
  config: EvalConfig;
  spec: Spec;
  evidence: ScenarioEvidence[];
  runDir: string;
}): Promise<AreaJudgement> {
  const { client, config, spec, evidence, runDir } = opts;

  const autoItems = spec.rubric.filter((r) => r.testability !== "manual");
  if (autoItems.length === 0) {
    return { area: spec.area, items: [], defects: [], area_notes: "No auto-judgeable items." };
  }

  const rubricText = renderRubric(autoItems);

  // Read the selected files here; the harness judge gets the same list as paths.
  const shots = selectScreenshots(evidence, runDir).map((s) => ({
    label: s.label,
    base64: fs.readFileSync(s.abs).toString("base64"),
  }));
  const attached = new Set(shots.map((s) => s.label));
  const content: Anthropic.ContentBlockParam[] = [
    {
      type: "text",
      text: [
        `FEATURE AREA: ${spec.title}`,
        `AREA OVERVIEW: ${spec.overview}`,
        ``,
        `RUBRIC (judge every item):`,
        rubricText,
        ``,
        `EVIDENCE:`,
        renderEvidence(evidence, attached),
        ``,
        `The following ${shots.length} screenshots are attached in order:`,
        ...shots.map((s, i) => `  image ${i + 1}: ${s.label}`),
      ].join("\n"),
    },
    ...shots.flatMap((s): Anthropic.ContentBlockParam[] => [
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: s.base64 },
      },
    ]),
  ];

  // A 17-item rubric with cited reasoning plus a defect list overruns 16k and
  // truncates mid-JSON, failing the whole area's parse — so budget 32k. The SDK
  // requires streaming at that size, so stream and parse the final message.
  const stream = client.messages.stream({
    model: config.judgeModel!,
    max_tokens: 32000,
    system: JUDGE_SYSTEM,
    messages: [{ role: "user", content }],
    output_config: { format: zodOutputFormat(JudgementSchema) },
  });
  const message = await stream.finalMessage();

  let parsedOutput: z.infer<typeof JudgementSchema> | null = null;
  if (message.stop_reason !== "refusal") {
    const text = message.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
    try {
      parsedOutput = JudgementSchema.parse(JSON.parse(text));
    } catch (err: any) {
      console.warn(`  judge output did not parse for ${spec.area}: ${err?.message?.slice(0, 160)}`);
    }
  }
  const response = { stop_reason: message.stop_reason, parsed_output: parsedOutput };

  if (response.stop_reason === "max_tokens") {
    console.warn(
      `  judge output hit max_tokens for ${spec.area} — verdicts may be truncated; re-judge with a higher cap`,
    );
  }
  if (response.stop_reason === "refusal" || !response.parsed_output) {
    return {
      area: spec.area,
      items: autoItems.map((r) => ({
        id: r.id,
        verdict: "cannot_judge" as const,
        confidence: "low" as const,
        reasoning: "Judge call failed or was refused; re-run this area.",
        evidence_refs: [],
      })),
      defects: [],
      area_notes: "Judge failure — verdicts are placeholders.",
    };
  }

  const parsed = response.parsed_output;

  // Guarantee one verdict per rubric item even if the model dropped/duplicated any.
  const byId = new Map(parsed.items.map((i) => [i.id, i]));
  const items = autoItems.map(
    (r) =>
      byId.get(r.id) ?? {
        id: r.id,
        verdict: "cannot_judge" as const,
        confidence: "low" as const,
        reasoning: "Judge omitted this item.",
        evidence_refs: [],
      },
  );

  return { area: spec.area, items, defects: parsed.defects, area_notes: parsed.area_notes };
}
