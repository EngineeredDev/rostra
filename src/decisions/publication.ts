import type { ExecutionIsolation } from "../contracts/common.js";
import { AppError, errorMessage } from "../errors.js";
import type { StorageDatabase } from "../storage/database.js";
import { canonicalJson, parseJsonValue, type JsonValue } from "../utils/canonical-json.js";

interface PublishInput {
  jobId: string;
  decisionId: string;
  workspaceId: string;
  canonicalRoot: string;
  requestFingerprint: string;
  continuationId?: string;
  question: string;
  protocol: string;
  resultStatus: "complete" | "partial";
  canonicalResult: JsonValue;
  summary: string;
  executionIsolation: ExecutionIsolation;
  reviewDueAtMs: number;
  nowMs: number;
}

interface OriginRow {
  decision_id: string;
}

export interface PublishedDecision {
  id: string;
  workspace_id: string;
  question: string;
  result_status: "complete" | "partial";
  summary: string;
  canonical_result: JsonValue;
  created_at_ms: number;
}

interface DecisionRow {
  id: string;
  workspace_id: string;
  question: string;
  result_status: "complete" | "partial";
  summary: string;
  canonical_json: string;
  created_at_ms: number;
}

interface ThreadDecisionRow {
  id: string;
  thread_id: string | null;
}

export function resolveContinuationThread(input: {
  db: StorageDatabase;
  workspaceId: string;
  continuationId?: string;
  nowMs: number;
}): string | null {
  if (input.continuationId === undefined) return null;
  const parent = input.db
    .prepare<[string, string], ThreadDecisionRow>(`
    SELECT id, thread_id FROM decisions WHERE id = ? AND workspace_id = ?
  `)
    .get(input.continuationId, input.workspaceId);
  if (parent === undefined) {
    throw new AppError("continuation_not_found", input.continuationId);
  }
  if (parent.thread_id !== null) return parent.thread_id;
  input.db
    .prepare(`
    INSERT INTO threads(id, workspace_id, parent_thread_id, created_at_ms)
    VALUES (?, ?, NULL, ?)
  `)
    .run(parent.id, input.workspaceId, input.nowMs);
  const updated = input.db
    .prepare(`
    UPDATE decisions SET thread_id = ?, updated_at_ms = ?
    WHERE id = ? AND workspace_id = ? AND thread_id IS NULL
  `)
    .run(parent.id, input.nowMs, parent.id, input.workspaceId);
  if (updated.changes !== 1) {
    throw new AppError("continuation_conflict", parent.id);
  }
  return parent.id;
}

export class DecisionPublisher {
  readonly #db: StorageDatabase;

  constructor(db: StorageDatabase) {
    this.#db = db;
  }

  publish(input: PublishInput): { decisionId: string; created: boolean } {
    return this.#db
      .transaction(() => {
        const existing = this.#db
          .prepare<[string], OriginRow>("SELECT decision_id FROM decision_origins WHERE job_id = ?")
          .get(input.jobId);
        if (existing !== undefined) {
          return { decisionId: existing.decision_id, created: false };
        }

        try {
          this.#db
            .prepare(`
          INSERT INTO workspaces(id, canonical_root, created_at_ms)
          VALUES (?, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `)
            .run(input.workspaceId, input.canonicalRoot, input.nowMs);
          const threadId = resolveContinuationThread({
            db: this.#db,
            workspaceId: input.workspaceId,
            ...(input.continuationId === undefined ? {} : { continuationId: input.continuationId }),
            nowMs: input.nowMs,
          });
          this.#db
            .prepare(`
          INSERT INTO decisions(
            id, workspace_id, thread_id, question, protocol, result_status,
            outcome_status, canonical_json, summary, execution_isolation,
            review_due_at_ms, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
            .run(
              input.decisionId,
              input.workspaceId,
              threadId,
              input.question,
              input.protocol,
              input.resultStatus,
              input.resultStatus,
              canonicalJson(input.canonicalResult),
              input.summary,
              input.executionIsolation,
              input.reviewDueAtMs,
              input.nowMs,
              input.nowMs,
            );
          this.#db
            .prepare(`
          INSERT INTO decision_origins(job_id, decision_id, request_fingerprint, committed_at_ms)
          VALUES (?, ?, ?, ?)
        `)
            .run(input.jobId, input.decisionId, input.requestFingerprint, input.nowMs);
        } catch (error) {
          throw new AppError("decision_publication_failed", errorMessage(error));
        }
        return { decisionId: input.decisionId, created: true };
      })
      .immediate();
  }

  getDecision(decisionId: string): PublishedDecision | undefined {
    const row = this.#db
      .prepare<[string], DecisionRow>(`
      SELECT id, workspace_id, question, result_status, summary, canonical_json, created_at_ms
      FROM decisions WHERE id = ?
    `)
      .get(decisionId);
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      question: row.question,
      result_status: row.result_status,
      summary: row.summary,
      canonical_result: parseJsonValue(JSON.parse(row.canonical_json)),
      created_at_ms: row.created_at_ms,
    };
  }
}
