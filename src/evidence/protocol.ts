import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod/v4";
import { uuidSchema } from "../contracts/common.js";
import { evidenceRecordSchema, type EvidenceRecord } from "../contracts/results.js";
import { AppError, errorMessage } from "../errors.js";
import { parseJsonValue, type JsonValue } from "../utils/canonical-json.js";
import { evidenceOperationNames } from "./operations.js";
import type { EvidenceWorkspace } from "./workspace.js";

const operationSchema = z.enum(evidenceOperationNames);
const requestSchema = z.strictObject({
  name: operationSchema,
  arguments: z.record(z.string(), z.json()),
  claim_id: uuidSchema.optional(),
  polarity: z.enum(["supports", "refutes", "neutral"]).default("neutral"),
});

const pathArgumentsSchema = z.strictObject({ path: z.string().min(1) });
const searchArgumentsSchema = z.strictObject({ query: z.string().min(1) });
const emptyArgumentsSchema = z.strictObject({});

export type EvidenceOperationName = z.infer<typeof operationSchema>;
export type EvidenceToolRequest = z.infer<typeof requestSchema>;

export interface EvidenceToolResult {
  response: JsonValue;
  evidence?: EvidenceRecord;
}

export function extractEvidenceToolRequest(rawText: string): EvidenceToolRequest | undefined {
  const marker = "AI_COUNSEL_TOOL_REQUEST:";
  const lines = rawText.split(/\r?\n/u)
    .filter((line) => line.trimStart().startsWith(marker));
  if (lines.length > 1 || (lines.length === 1 && rawText.includes("AI_COUNSEL_RESULT:"))) {
    throw new AppError("invalid_evidence_request", "A response must contain one tool request or one final result");
  }
  const last = lines.at(-1);
  if (last === undefined) return undefined;
  const encoded = last.trimStart().slice(marker.length).trim();
  try {
    return requestSchema.parse(JSON.parse(encoded));
  } catch (error) {
    throw new AppError("invalid_evidence_request", errorMessage(error));
  }
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function record(input: {
  request: EvidenceToolRequest;
  sourceType: "file" | "git";
  canonicalUri: string;
  locator?: string;
  hash: string;
  nowMs: number;
  id: string;
}): EvidenceRecord {
  return evidenceRecordSchema.parse({
    evidence_id: input.id,
    ...(input.request.claim_id === undefined ? {} : { claim_id: input.request.claim_id }),
    source_type: input.sourceType,
    canonical_uri: input.canonicalUri,
    ...(input.locator === undefined ? {} : { locator: input.locator }),
    content_hash: input.hash,
    captured_at_ms: input.nowMs,
    tool_or_adapter: input.request.name,
    execution_isolation: "builtin_confined",
    redaction_status: "none",
    polarity: input.request.polarity,
  });
}

export async function executeEvidenceTool(input: {
  workspace: EvidenceWorkspace;
  request: EvidenceToolRequest;
  allowedCapabilities: ReadonlySet<string>;
  nowMs?: number;
  createId?: () => string;
}): Promise<EvidenceToolResult> {
  if (!input.allowedCapabilities.has(input.request.name)) {
    throw new AppError(
      "evidence_capability_denied",
      `Stage does not allow ${input.request.name}`,
    );
  }
  const nowMs = input.nowMs ?? Date.now();
  const createId = input.createId ?? randomUUID;
  if (input.request.name === "read_file") {
    const { path } = pathArgumentsSchema.parse(input.request.arguments);
    const result = await input.workspace.readFile(path);
    const evidence = record({
      request: input.request,
      sourceType: "file",
      canonicalUri: pathToFileURL(resolve(input.workspace.root, result.relativePath)).href,
      locator: result.relativePath,
      hash: result.contentHash,
      nowMs,
      id: createId(),
    });
    return {
      response: parseJsonValue({
        name: input.request.name,
        evidence_id: evidence.evidence_id,
        path: result.relativePath,
        content_hash: result.contentHash,
        bytes: result.bytes,
        content: result.text,
      }),
      evidence,
    };
  }
  if (input.request.name === "search_files") {
    const { query } = searchArgumentsSchema.parse(input.request.arguments);
    return {
      response: parseJsonValue({ name: input.request.name, ...(await input.workspace.searchFiles(query)) }),
    };
  }
  if (input.request.name === "list_files") {
    emptyArgumentsSchema.parse(input.request.arguments);
    return {
      response: parseJsonValue({ name: input.request.name, files: await input.workspace.listFiles() }),
    };
  }
  if (input.request.name === "get_file_tree") {
    emptyArgumentsSchema.parse(input.request.arguments);
    return {
      response: parseJsonValue({ name: input.request.name, ...(await input.workspace.getFileTree()) }),
    };
  }
  emptyArgumentsSchema.parse(input.request.arguments);
  const content = input.request.name === "git_status"
    ? await input.workspace.gitStatus()
    : await input.workspace.gitDiff();
  const evidence = record({
    request: input.request,
    sourceType: "git",
    canonicalUri: `git+workspace://${input.request.name}`,
    hash: contentHash(content),
    nowMs,
    id: createId(),
  });
  return {
    response: parseJsonValue({
      name: input.request.name,
      evidence_id: evidence.evidence_id,
      content_hash: evidence.content_hash,
      content,
    }),
    evidence,
  };
}
