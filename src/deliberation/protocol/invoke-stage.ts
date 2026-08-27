import type { StageKind } from "../../config/schema.js";
import { extractStageSubmission } from "../../contracts/submissions.js";
import { AppError } from "../../errors.js";
import { canonicalJson, type JsonValue } from "../../utils/canonical-json.js";

export type StageAttemptKind = "stage" | "tool_continuation" | "structured_retry";

interface StructuredStageInput {
  kind: StageKind;
  prompt: string;
  invoke: (prompt: string, attemptKind: StageAttemptKind) => Promise<string>;
  onToolRequest?: (rawText: string) => Promise<JsonValue | undefined>;
  maxToolContinuations?: number;
}

export interface StructuredStageResult {
  rawText: string;
  submission: unknown;
  attempts: readonly {
    kind: StageAttemptKind;
    rawText: string;
  }[];
}

async function invokeUntilResult(
  input: StructuredStageInput,
  initialPrompt: string,
  initialKind: StageAttemptKind,
): Promise<{ rawText: string; attempts: { kind: StageAttemptKind; rawText: string }[] }> {
  const attempts: { kind: StageAttemptKind; rawText: string }[] = [];
  let prompt = initialPrompt;
  let kind = initialKind;
  const maximum = input.maxToolContinuations ?? 4;
  for (let continuation = 0; ; continuation += 1) {
    const rawText = await input.invoke(prompt, kind);
    attempts.push({ kind, rawText });
    const toolResult = await input.onToolRequest?.(rawText);
    if (toolResult === undefined) return { rawText, attempts };
    if (continuation >= maximum) {
      throw new AppError(
        "evidence_request_limit",
        `Stage ${input.kind} exceeded ${maximum} evidence requests`,
      );
    }
    prompt = [
      initialPrompt,
      "The prior response requested one bounded evidence operation.",
      "Prior response:",
      rawText,
      `AI_COUNSEL_TOOL_RESULT: ${canonicalJson(toolResult)}`,
      "Use this result. Request another allowed operation or return the final structured result.",
    ].join("\n\n");
    kind = "tool_continuation";
  }
}

export async function invokeStructuredStage(
  input: StructuredStageInput,
): Promise<StructuredStageResult> {
  const first = await invokeUntilResult(input, input.prompt, "stage");
  try {
    const extracted = extractStageSubmission(input.kind, first.rawText);
    return {
      rawText: extracted.raw_text,
      submission: extracted.submission,
      attempts: first.attempts,
    };
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "invalid_stage_result") throw error;
  }

  const repairPrompt = [
    "Return only a corrected structured result for the prior response.",
    `The stage kind is ${input.kind}.`,
    "End with exactly one AI_COUNSEL_RESULT: {JSON} line.",
    "Prior response:",
    first.rawText,
  ].join("\n\n");
  const retry = await invokeUntilResult(input, repairPrompt, "structured_retry");
  try {
    const extracted = extractStageSubmission(input.kind, retry.rawText);
    return {
      rawText: extracted.raw_text,
      submission: extracted.submission,
      attempts: [...first.attempts, ...retry.attempts],
    };
  } catch {
    throw new AppError(
      "structured_stage_failed",
      `${input.kind} failed structured extraction twice`,
      { firstRaw: first.rawText, retryRaw: retry.rawText },
    );
  }
}
