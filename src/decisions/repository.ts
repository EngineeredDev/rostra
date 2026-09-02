import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";
import type { QueryDecisionsInput } from "../contracts/tools.js";
import type { StorageDatabase } from "../storage/database.js";
import { AppError } from "../errors.js";
import { canonicalJson, parseJsonValue, type JsonValue } from "../utils/canonical-json.js";
import { sha256File } from "../utils/hash-file.js";
import { deriveWorkspaceIdentity, type WorkspaceIdentity } from "./workspace.js";

interface DecisionRow {
  id: string;
  workspace_id: string;
  thread_id: string | null;
  question: string;
  protocol: string;
  result_status: "complete" | "partial";
  outcome_status: string;
  canonical_json: string;
  summary: string;
  execution_isolation: "builtin_confined" | "host_unrestricted";
  review_due_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
}

interface CriticalEvidenceRow {
  id: string;
  source_type: string;
  canonical_uri: string;
  content_hash: string;
  expires_at_ms: number | null;
}

export interface DecisionView {
  id: string;
  question: string;
  protocol: string;
  result_status: "complete" | "partial";
  outcome_status: string;
  summary: string;
  canonical_result: JsonValue;
  execution_isolation: "builtin_confined" | "host_unrestricted";
  created_at_ms: number;
  review_due_at_ms: number;
  stale: boolean;
  warnings: string[];
  contradictions: string[];
}

export interface DecisionPage {
  decisions: DecisionView[];
  next_cursor?: string;
}

interface OutcomeInput {
  working_directory: string;
  decision_id: string;
  status: "confirmed" | "disconfirmed" | "mixed" | "superseded" | "unknown";
  observed_at: string;
  measurements: Record<string, JsonValue>;
  notes?: string;
  superseding_decision_id?: string;
}

function cursorValue(
  cursor: string | undefined,
): { created_at_ms: number; id: string } | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  try {
    return z
      .strictObject({ created_at_ms: z.number().int(), id: z.string() })
      .parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new AppError("invalid_cursor", "Decision cursor is invalid");
  }
}

export class DecisionRepository {
  readonly #db: StorageDatabase;

  constructor(db: StorageDatabase) {
    this.#db = db;
  }

  #ensureWorkspace(workspace: WorkspaceIdentity, nowMs = Date.now()): void {
    this.#db
      .prepare(`
      INSERT INTO workspaces(id, canonical_root, created_at_ms) VALUES (?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `)
      .run(workspace.id, workspace.canonicalRoot, nowMs);
  }

  #row(decisionId: string, workspaceId: string): DecisionRow {
    const row = this.#db
      .prepare<[string, string], DecisionRow>(`
      SELECT * FROM decisions WHERE id = ? AND workspace_id = ?
    `)
      .get(decisionId, workspaceId);
    if (row === undefined) {
      throw new AppError("decision_not_found", `Decision not found: ${decisionId}`);
    }
    return row;
  }

  async #staleness(row: DecisionRow, nowMs = Date.now()): Promise<string[]> {
    const warnings: string[] = [];
    if (row.review_due_at_ms <= nowMs) {
      warnings.push("review_due");
    }
    const superseded = this.#db
      .prepare<[string, string], { present: number }>(`
      SELECT 1 AS present FROM decision_relations
      WHERE workspace_id = ? AND target_decision_id = ? AND relation_type = 'supersedes'
      LIMIT 1
    `)
      .get(row.workspace_id, row.id);
    if (superseded !== undefined) {
      warnings.push("superseded");
    }
    const evidence = this.#db
      .prepare<[string, string], CriticalEvidenceRow>(`
      SELECT e.id, e.source_type, e.canonical_uri, e.content_hash, e.expires_at_ms
      FROM claim_evidence ce
      JOIN claims c ON c.id = ce.claim_id AND c.workspace_id = ce.workspace_id
      JOIN evidence e ON e.id = ce.evidence_id AND e.workspace_id = ce.workspace_id
      WHERE ce.workspace_id = ? AND c.decision_id = ? AND ce.is_critical = 1
      ORDER BY e.id
    `)
      .all(row.workspace_id, row.id);
    for (const item of evidence) {
      if (item.expires_at_ms !== null && item.expires_at_ms <= nowMs) {
        warnings.push(`expired_evidence:${item.id}`);
      }
      if (item.source_type === "file") {
        const path = item.canonical_uri.startsWith("file:")
          ? fileURLToPath(item.canonical_uri)
          : item.canonical_uri;
        try {
          await access(path);
          if ((await sha256File(path)) !== item.content_hash) {
            warnings.push(`changed_evidence:${item.id}`);
          }
        } catch {
          warnings.push(`missing_evidence:${item.id}`);
        }
      } else if (item.source_type === "adapter") {
        warnings.push(`unverified_evidence:${item.id}`);
      }
    }
    return warnings;
  }

  async #view(row: DecisionRow, findContradictions: boolean): Promise<DecisionView> {
    const warnings = await this.#staleness(row);
    const contradictions = findContradictions
      ? this.#db
          .prepare<[string, string, string, string], { id: string }>(`
          SELECT CASE
            WHEN source_decision_id = ? THEN target_decision_id
            ELSE source_decision_id
          END AS id
          FROM decision_relations
          WHERE workspace_id = ? AND relation_type = 'contradicts'
            AND (source_decision_id = ? OR target_decision_id = ?)
          ORDER BY id
        `)
          .all(row.id, row.workspace_id, row.id, row.id)
          .map((item) => item.id)
      : [];
    return {
      id: row.id,
      question: row.question,
      protocol: row.protocol,
      result_status: row.result_status,
      outcome_status: row.outcome_status,
      summary: row.summary,
      canonical_result: parseJsonValue(JSON.parse(row.canonical_json)),
      execution_isolation: row.execution_isolation,
      created_at_ms: row.created_at_ms,
      review_due_at_ms: row.review_due_at_ms,
      stale: warnings.some((warning) => !warning.startsWith("unverified_evidence:")),
      warnings,
      contradictions,
    };
  }

  async query(input: QueryDecisionsInput): Promise<DecisionPage> {
    const workspace = await deriveWorkspaceIdentity(input.working_directory);
    this.#ensureWorkspace(workspace);
    if (input.decision_id !== undefined) {
      const view = await this.#view(
        this.#row(input.decision_id, workspace.id),
        input.find_contradictions,
      );
      return { decisions: !input.include_stale && view.stale ? [] : [view] };
    }

    const cursor = cursorValue(input.cursor);
    const parameters: unknown[] = [workspace.id];
    const conditions = ["d.workspace_id = ?"];
    if (cursor !== undefined) {
      conditions.push("(d.created_at_ms > ? OR (d.created_at_ms = ? AND d.id > ?))");
      parameters.push(cursor.created_at_ms, cursor.created_at_ms, cursor.id);
    }
    if (input.query_text !== undefined && input.query_text !== "") {
      conditions.push(`(
        d.question LIKE ? OR d.summary LIKE ? OR EXISTS (
          SELECT 1 FROM claims c WHERE c.decision_id = d.id AND c.workspace_id = d.workspace_id
            AND c.text LIKE ?
        )
      )`);
      const pattern = `%${input.query_text}%`;
      parameters.push(pattern, pattern, pattern);
    } else if (input.continuation_id !== undefined) {
      const parent = this.#row(input.continuation_id, workspace.id);
      if (parent.thread_id === null) {
        conditions.push("d.id = ?");
        parameters.push(parent.id);
      } else {
        conditions.push("d.thread_id = ?");
        parameters.push(parent.thread_id);
      }
    }
    parameters.push(input.limit + 1);
    const rows = this.#db
      .prepare<unknown[], DecisionRow>(`
      SELECT d.* FROM decisions d
      WHERE ${conditions.join(" AND ")}
      ORDER BY d.created_at_ms, d.id
      LIMIT ?
    `)
      .all(...parameters);
    const views: DecisionView[] = [];
    for (const row of rows) {
      const view = await this.#view(row, input.find_contradictions);
      if (input.include_stale || !view.stale) {
        views.push(view);
      }
    }
    const hasMore = views.length > input.limit;
    const decisions = hasMore ? views.slice(0, input.limit) : views;
    const last = decisions.at(-1);
    return {
      decisions,
      ...(hasMore && last !== undefined
        ? {
            next_cursor: Buffer.from(
              JSON.stringify({
                created_at_ms: last.created_at_ms,
                id: last.id,
              }),
            ).toString("base64url"),
          }
        : {}),
    };
  }

  async listStale(workingDirectory: string, limit: number, cursor?: string): Promise<DecisionPage> {
    const page = await this.query({
      working_directory: workingDirectory,
      query_text: "",
      ...(cursor === undefined ? {} : { cursor }),
      limit: 100,
      format: "json",
      include_stale: true,
      find_contradictions: false,
    });
    const stale = page.decisions.filter((decision) => decision.stale).slice(0, limit);
    return {
      decisions: stale,
      ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }),
    };
  }

  async recordOutcome(input: OutcomeInput): Promise<{ outcome_id: string; decision_id: string }> {
    const workspace = await deriveWorkspaceIdentity(input.working_directory);
    const decision = this.#row(input.decision_id, workspace.id);
    if (input.status === "superseded") {
      if (input.superseding_decision_id === undefined) {
        throw new AppError("invalid_outcome", "A superseding decision is required");
      }
      this.#row(input.superseding_decision_id, workspace.id);
    }
    const outcomeId = randomUUID();
    const nowMs = Date.now();
    this.#db
      .transaction(() => {
        this.#db
          .prepare(`
        INSERT INTO outcomes(
          id, workspace_id, decision_id, prediction_id, status, observed_at,
          measurements_json, notes, superseding_decision_id, created_at_ms
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
      `)
          .run(
            outcomeId,
            workspace.id,
            decision.id,
            input.status,
            input.observed_at,
            canonicalJson(parseJsonValue(input.measurements)),
            input.notes ?? null,
            input.superseding_decision_id ?? null,
            nowMs,
          );
        if (input.status === "confirmed" || input.status === "disconfirmed") {
          this.#db
            .prepare(`
          UPDATE predictions SET resolved_label = ?, resolved_at_ms = ?
          WHERE workspace_id = ? AND decision_id = ? AND resolved_label IS NULL
        `)
            .run(input.status === "confirmed" ? 1 : 0, nowMs, workspace.id, decision.id);
        }
        if (input.status === "superseded" && input.superseding_decision_id !== undefined) {
          this.#db
            .prepare(`
          INSERT OR IGNORE INTO decision_relations(
            id, workspace_id, source_decision_id, target_decision_id, relation_type, created_at_ms
          ) VALUES (?, ?, ?, ?, 'supersedes', ?)
        `)
            .run(randomUUID(), workspace.id, input.superseding_decision_id, decision.id, nowMs);
        }
        this.#db
          .prepare(`
        UPDATE decisions SET outcome_status = ?, updated_at_ms = ?
        WHERE id = ? AND workspace_id = ?
      `)
          .run(input.status, nowMs, decision.id, workspace.id);
      })
      .immediate();
    return { outcome_id: outcomeId, decision_id: decision.id };
  }
}
