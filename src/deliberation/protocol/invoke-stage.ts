import type { StageKind } from "../../config/schema.js";
import { extractStageSubmission } from "../../contracts/submissions.js";
import { AppError } from "../../errors.js";
import { stageResultExample } from "../../prompts/stage.js";
import { canonicalJson, type JsonValue } from "../../utils/canonical-json.js";

export type StageAttemptKind = "stage" | "tool_continuation" | "structured_retry";

const MAXIMUM_REPORTED_ISSUES = 12;

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
      `ROSTRA_TOOL_RESULT: ${canonicalJson(toolResult)}`,
      "Use this result. Request another allowed operation or return the final structured result.",
    ].join("\n\n");
    kind = "tool_continuation";
  }
}

function describeRejection(error: AppError): string {
  const issues = error.details;
  if (!Array.isArray(issues)) return error.message;
  const described = issues
    .slice(0, MAXIMUM_REPORTED_ISSUES)
    .map((issue) => {
      const path = (issue as { path?: readonly (string | number)[] }).path ?? [];
      const message = (issue as { message?: string }).message ?? "invalid value";
      return path.length === 0 ? `- ${message}` : `- ${path.join(".")}: ${message}`;
    });
  if (issues.length > MAXIMUM_REPORTED_ISSUES) {
    described.push(`- (${issues.length - MAXIMUM_REPORTED_ISSUES} further violations omitted)`);
  }
  return [error.message, ...described].join("\n");
}

export async function invokeStructuredStage(
  input: StructuredStageInput,
): Promise<StructuredStageResult> {
  const first = await invokeUntilResult(input, input.prompt, "stage");
  let rejection: AppError;
  try {
    const extracted = extractStageSubmission(input.kind, first.rawText);
    return {
      rawText: extracted.raw_text,
      submission: extracted.submission,
      attempts: first.attempts,
    };
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "invalid_stage_result") throw error;
    rejection = error;
  }

  const repairPrompt = [
    "Return only a corrected structured result for the prior response.",
    `The stage kind is ${input.kind}.`,
    "The prior result was rejected:",
    describeRejection(rejection),
    "Reuse the prior reasoning; change only the structure so it matches this shape exactly.",
    `ROSTRA_RESULT: ${stageResultExample(input.kind)}`,
    "End with exactly one ROSTRA_RESULT: {JSON} line.",
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
