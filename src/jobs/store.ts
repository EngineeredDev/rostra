import { createHash, randomUUID } from "node:crypto";
import { z } from "zod/v4";
import type { ExecutionIsolation } from "../contracts/common.js";
import type { DecisionPacket } from "../contracts/results.js";
import type { JobStatus, StartDeliberationInput } from "../contracts/tools.js";
import { startDeliberationInputSchema } from "../contracts/tools.js";
import { resolveContinuationThread } from "../decisions/publication.js";
import { AppError, errorMessage } from "../errors.js";
import type { StorageDatabase } from "../storage/database.js";
import { canonicalJson, parseJsonValue, type JsonValue } from "../utils/canonical-json.js";
import { assertTransition, isTerminalStatus } from "./state-machine.js";
import {
  attemptStatusSchema,
  jobAttemptSchema,
  jobEventSchema,
  jobSnapshotSchema,
  type AttemptStatus,
  type JobAttempt,
  type JobEvent,
  type JobSnapshot,
} from "./schema.js";


interface JobRow {
  job_id: string;
  idempotency_key: string | null;
  request_fingerprint: string;
  canonical_request_json: string;
  question: string;
  status: JobStatus;
  row_version: number;
  lease_token: string | null;
  lease_expires_at_ms: number | null;
  dispatch_token: string | null;
  cancellation_reason: string | null;
  recovery_reason: string | null;
  result_status: "complete" | "partial" | null;
  result_json: string | null;
  decision_id: string | null;
  transcript_path: string | null;
  execution_isolation: ExecutionIsolation;
  build_id: string | null;
  config_digest: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  terminal_at_ms: number | null;
}

interface EventRow {
  job_id: string;
  seq: number;
  event_type: string;
  payload_json: string;
  created_at_ms: number;
}

interface AttemptRow {
  attempt_id: string;
  job_id: string;
  stage_id: string;
  participant_id: string;
  attempt_kind: string;
  ordinal: number;
  request_digest: string;
  status: AttemptStatus;
  external_started: 0 | 1;
  response_id: string | null;
  response_digest: string | null;
  raw_response: string | null;
  error_type: string | null;
  error_message: string | null;
  execution_isolation: ExecutionIsolation;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  started_at_ms: number | null;
  terminal_at_ms: number | null;
  created_at_ms: number;
}

interface ProcessRow {
  process_id: string;
  pid: number;
  pid_started_at_ms: number;
  process_group_id: number | null;
}

export interface RunningProcess {
  processId: string;
  pid: number;
  startedAtMs: number;
  processGroupId?: number;
}

interface QualityRow {
  adapter: string;
  model: string;
  domain: string;
  attempts: number;
  valid_attempts: number;
  valid_ballots: number;
  abstentions: number;
  failures: number;
  latency_samples_json: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  resolved_predictions: number;
  brier_sum: number;
  updated_at_ms: number;
}

export interface QualityMetric extends Omit<QualityRow, "latency_samples_json" | "cost_usd"> {
  latency_samples_ms: number[];
  cost_usd?: number;
}

export interface QualitySample {
  adapter: string;
  model: string;
  domain: string;
  countAttempt?: boolean;
  valid_attempt?: boolean;
  valid_ballot?: boolean;
  abstention?: boolean;
  failure?: boolean;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  resolvedPrediction?: boolean;
  brierScore?: number;
  nowMs?: number;
}

interface StoreOptions {
  dedupeSuccessMs: number;
  leaseMs: number;
}

interface SubmitOptions {
  idempotencyKey?: string;
  forceNew?: boolean;
  nowMs?: number;
}

export interface Submission {
  job_id: string;
  status: JobStatus;
  deduplicated: boolean;
  idempotency_key?: string;
  result?: JsonValue;
}

interface ListOptions {
  statuses?: readonly JobStatus[];
  cursor?: string | undefined;
  limit?: number;
}

export interface JobPage {
  jobs: JobSnapshot[];
  next_cursor?: string;
}

interface TransitionInput {
  jobId: string;
  expectedStatus: JobStatus;
  nextStatus: JobStatus;
  expectedVersion: number;
  eventType: string;
  leaseToken?: string | undefined;
  eventPayload?: JsonValue;
  nowMs?: number;
  updates?: {
    resultStatus?: "complete" | "partial";
    resultJson?: JsonValue;
    decisionId?: string;
    transcriptPath?: string;
    recoveryReason?: string;
  };
}

interface CreateAttemptInput {
  jobId: string;
  stageId: string;
  participantId: string;
  attemptKind: string;
  ordinal: number;
  requestDigest: string;
  executionIsolation: ExecutionIsolation;
  nowMs?: number;
}

interface FinishAttemptDetails {
  responseId?: string;
  responseDigest?: string;
  rawResponse?: string;
  errorType?: string;
  errorMessage?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface DecisionCommitInput {
  jobId: string;
  expectedVersion: number;
  leaseToken: string;
  workspaceId: string;
  canonicalRoot: string;
  requestFingerprint: string;
  packet: DecisionPacket;
  summary: string;
  resultStatus: "complete" | "partial";
  resultJson: JsonValue;
  transcriptPath: string;
  nowMs?: number;
}



function rowToJob(row: JobRow): JobSnapshot {
  const result = row.result_json === null ? undefined : parseJsonValue(JSON.parse(row.result_json));
  return jobSnapshotSchema.parse({
    job_id: row.job_id,
    ...(row.idempotency_key === null ? {} : { idempotency_key: row.idempotency_key }),
    request_fingerprint: row.request_fingerprint,
    request: startDeliberationInputSchema.parse(JSON.parse(row.canonical_request_json)),
    question: row.question,
    status: row.status,
    row_version: row.row_version,
    ...(row.lease_token === null ? {} : { lease_token: row.lease_token }),
    ...(row.lease_expires_at_ms === null ? {} : { lease_expires_at_ms: row.lease_expires_at_ms }),
    ...(row.dispatch_token === null ? {} : { dispatch_token: row.dispatch_token }),
    ...(row.cancellation_reason === null ? {} : { cancellation_reason: row.cancellation_reason }),
    ...(row.recovery_reason === null ? {} : { recovery_reason: row.recovery_reason }),
    ...(row.result_status === null ? {} : { result_status: row.result_status }),
    ...(result === undefined ? {} : { result_json: result }),
    ...(row.decision_id === null ? {} : { decision_id: row.decision_id }),
    ...(row.transcript_path === null ? {} : { transcript_path: row.transcript_path }),
    execution_isolation: row.execution_isolation,
    ...(row.build_id === null ? {} : { build_id: row.build_id }),
    ...(row.config_digest === null ? {} : { config_digest: row.config_digest }),
    created_at_ms: row.created_at_ms,
    updated_at_ms: row.updated_at_ms,
    ...(row.terminal_at_ms === null ? {} : { terminal_at_ms: row.terminal_at_ms }),
  });
}

function rowToAttempt(row: AttemptRow): JobAttempt {
  return jobAttemptSchema.parse({
    attempt_id: row.attempt_id,
    job_id: row.job_id,
    stage_id: row.stage_id,
    participant_id: row.participant_id,
    attempt_kind: row.attempt_kind,
    ordinal: row.ordinal,
    request_digest: row.request_digest,
    status: row.status,
    external_started: row.external_started === 1,
    ...(row.response_id === null ? {} : { response_id: row.response_id }),
    ...(row.response_digest === null ? {} : { response_digest: row.response_digest }),
    ...(row.raw_response === null ? {} : { raw_response: row.raw_response }),
    ...(row.error_type === null ? {} : { error_type: row.error_type }),
    ...(row.error_message === null ? {} : { error_message: row.error_message }),
    execution_isolation: row.execution_isolation,
    ...(row.latency_ms === null ? {} : { latency_ms: row.latency_ms }),
    ...(row.input_tokens === null ? {} : { input_tokens: row.input_tokens }),
    ...(row.output_tokens === null ? {} : { output_tokens: row.output_tokens }),
    ...(row.cost_usd === null ? {} : { cost_usd: row.cost_usd }),
    ...(row.started_at_ms === null ? {} : { started_at_ms: row.started_at_ms }),
    ...(row.terminal_at_ms === null ? {} : { terminal_at_ms: row.terminal_at_ms }),
    created_at_ms: row.created_at_ms,
  });
}

function rowToQuality(row: QualityRow): QualityMetric {
  return {
    adapter: row.adapter,
    model: row.model,
    domain: row.domain,
    attempts: row.attempts,
    valid_attempts: row.valid_attempts,
    valid_ballots: row.valid_ballots,
    abstentions: row.abstentions,
    failures: row.failures,
    latency_samples_ms: z.array(z.number().int().nonnegative()).parse(
      JSON.parse(row.latency_samples_json),
    ),
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    ...(row.cost_usd === null ? {} : { cost_usd: row.cost_usd }),
    resolved_predictions: row.resolved_predictions,
    brier_sum: row.brier_sum,
    updated_at_ms: row.updated_at_ms,
  };
}

export class JobStore {
  readonly #db: StorageDatabase;
  readonly #options: StoreOptions;

  constructor(db: StorageDatabase, options: StoreOptions) {
    this.#db = db;
    this.#options = options;
  }

  close(): void {
    this.#db.close();
  }

  #immediate<T>(action: () => T): T {
    const transaction = this.#db.transaction(action);
    return transaction.immediate();
  }

  #jobRow(jobId: string): JobRow {
    const row = this.#db.prepare<[string], JobRow>("SELECT * FROM jobs WHERE job_id = ?").get(jobId);
    if (row === undefined) {
      throw new AppError("job_not_found", `Unknown job: ${jobId}`);
    }
    return row;
  }

  #appendEvent(jobId: string, eventType: string, payload: JsonValue, nowMs: number): void {
    const sequence = this.#db
      .prepare<[string], { next_event_seq: number }>("SELECT next_event_seq FROM jobs WHERE job_id = ?")
      .get(jobId);
    if (sequence === undefined) {
      throw new AppError("job_not_found", `Unknown job: ${jobId}`);
    }
    this.#db.prepare(
      "INSERT INTO job_events(job_id, seq, event_type, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?)",
    ).run(jobId, sequence.next_event_seq, eventType, canonicalJson(payload), nowMs);
    this.#db.prepare("UPDATE jobs SET next_event_seq = next_event_seq + 1 WHERE job_id = ?").run(jobId);
  }

  #submission(job: JobSnapshot, deduplicated: boolean): Submission {
    return {
      job_id: job.job_id,
      status: job.status,
      deduplicated,
      ...(job.idempotency_key === undefined ? {} : { idempotency_key: job.idempotency_key }),
      ...(job.result_json === undefined ? {} : { result: job.result_json }),
    };
  }

  submit(requestInput: StartDeliberationInput, options: SubmitOptions = {}): Submission {
    const request = startDeliberationInputSchema.parse(requestInput);
    const { idempotency_key: requestKey, force_new: requestForce, ...semanticRequest } = request;
    void requestKey;
    void requestForce;
    const canonicalRequest = canonicalJson(parseJsonValue(semanticRequest));
    const fingerprint = createHash("sha256").update(canonicalRequest).digest("hex");
    const idempotencyKey = options.idempotencyKey ?? request.idempotency_key;
    const forceNew = options.forceNew ?? request.force_new;
    const nowMs = options.nowMs ?? Date.now();

    return this.#immediate(() => {
      if (idempotencyKey !== undefined) {
        const existing = this.#db
          .prepare<[string], JobRow>("SELECT * FROM jobs WHERE idempotency_key = ?")
          .get(idempotencyKey);
        if (existing !== undefined) {
          if (existing.request_fingerprint !== fingerprint) {
            throw new AppError(
              "idempotency_conflict",
              `Idempotency key ${idempotencyKey} belongs to a different request`,
            );
          }
          return this.#submission(rowToJob(existing), true);
        }
      }

      if (!forceNew) {
        const existing = this.#db.prepare<[string, number], JobRow>(`
          SELECT * FROM jobs
          WHERE request_fingerprint = ?
            AND (status IN ('queued', 'dispatching', 'running', 'recovery_required', 'cancelling')
              OR (status = 'succeeded' AND terminal_at_ms >= ?))
          ORDER BY created_at_ms, job_id
          LIMIT 1
        `).get(fingerprint, nowMs - this.#options.dedupeSuccessMs);
        if (existing !== undefined) {
          return this.#submission(rowToJob(existing), true);
        }
      }

      const jobId = randomUUID();
      this.#db.prepare(`
        INSERT INTO jobs(
          job_id, idempotency_key, request_fingerprint, canonical_request_json,
          question, status, execution_isolation, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, 'queued', 'builtin_confined', ?, ?)
      `).run(jobId, idempotencyKey ?? null, fingerprint, canonicalRequest, request.question, nowMs, nowMs);
      this.#appendEvent(jobId, "submitted", { status: "queued" }, nowMs);
      return this.#submission(rowToJob(this.#jobRow(jobId)), false);
    });
  }

  get(jobId: string): JobSnapshot {
    return rowToJob(this.#jobRow(jobId));
  }

  getByIdempotencyKey(key: string): JobSnapshot | undefined {
    const row = this.#db
      .prepare<[string], JobRow>("SELECT * FROM jobs WHERE idempotency_key = ?")
      .get(key);
    return row === undefined ? undefined : rowToJob(row);
  }

  list(options: ListOptions = {}): JobPage {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const parameters: unknown[] = [];
    const conditions: string[] = [];
    if (options.cursor !== undefined) {
      let cursor: { created_at_ms: number; id: string };
      try {
        cursor = z.strictObject({ created_at_ms: z.number().int(), id: z.string() }).parse(
          JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")),
        );
      } catch (error) {
        throw new AppError("invalid_cursor", errorMessage(error));
      }
      conditions.push("(created_at_ms > ? OR (created_at_ms = ? AND job_id > ?))");
      parameters.push(cursor.created_at_ms, cursor.created_at_ms, cursor.id);
    }
    if (options.statuses !== undefined && options.statuses.length > 0) {
      conditions.push(`status IN (${options.statuses.map(() => "?").join(",")})`);
      parameters.push(...options.statuses);
    }
    parameters.push(limit + 1);
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const rows = this.#db
      .prepare<unknown[], JobRow>(`SELECT * FROM jobs ${where} ORDER BY created_at_ms, job_id LIMIT ?`)
      .all(...parameters);
    const hasMore = rows.length > limit;
    const selected = hasMore ? rows.slice(0, limit) : rows;
    const jobs = selected.map((row) => rowToJob(row));
    const last = jobs.at(-1);
    return {
      jobs,
      ...(hasMore && last !== undefined
        ? {
            next_cursor: Buffer.from(
              JSON.stringify({ created_at_ms: last.created_at_ms, id: last.job_id }),
            ).toString("base64url"),
          }
        : {}),
    };
  }

  claimNext(buildId: string, configDigest: string, nowMs = Date.now()): JobSnapshot | undefined {
    return this.#immediate(() => {
      const row = this.#db
        .prepare<[], JobRow>("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at_ms, job_id LIMIT 1")
        .get();
      if (row === undefined) {
        return undefined;
      }
      assertTransition(row.status, "dispatching");
      const leaseToken = randomUUID();
      const dispatchToken = randomUUID();
      const update = this.#db.prepare(`
        UPDATE jobs SET
          status = 'dispatching', row_version = row_version + 1,
          lease_token = ?, lease_expires_at_ms = ?, dispatch_token = ?,
          build_id = ?, config_digest = ?, updated_at_ms = ?
        WHERE job_id = ? AND status = 'queued' AND row_version = ?
      `).run(
        leaseToken,
        nowMs + this.#options.leaseMs,
        dispatchToken,
        buildId,
        configDigest,
        nowMs,
        row.job_id,
        row.row_version,
      );
      if (update.changes !== 1) {
        throw new AppError("lease_lost", `Failed to claim job ${row.job_id}`);
      }
      this.#appendEvent(row.job_id, "dispatching", { build_id: buildId }, nowMs);
      return rowToJob(this.#jobRow(row.job_id));
    });
  }

  handshakeWorker(
    jobId: string,
    dispatchToken: string | undefined,
    expectedVersion: number,
    nowMs = Date.now(),
  ): JobSnapshot {
    if (dispatchToken === undefined) {
      throw new AppError("dispatch_rejected", `Missing dispatch token for ${jobId}`);
    }
    return this.#immediate(() => {
      const workerLease = randomUUID();
      const update = this.#db.prepare(`
        UPDATE jobs SET
          status = 'running', row_version = row_version + 1,
          lease_token = ?, lease_expires_at_ms = ?, updated_at_ms = ?
        WHERE job_id = ? AND status = 'dispatching' AND dispatch_token = ? AND row_version = ?
      `).run(workerLease, nowMs + this.#options.leaseMs, nowMs, jobId, dispatchToken, expectedVersion);
      if (update.changes !== 1) {
        throw new AppError("dispatch_rejected", `Worker dispatch was rejected for ${jobId}`);
      }
      this.#appendEvent(jobId, "running", {}, nowMs);
      return rowToJob(this.#jobRow(jobId));
    });
  }

  heartbeat(
    jobId: string,
    leaseToken: string | undefined,
    expectedVersion: number,
    nowMs = Date.now(),
  ): JobSnapshot {
    if (leaseToken === undefined) {
      throw new AppError("lease_lost", `Missing lease token for ${jobId}`);
    }
    return this.#immediate(() => {
      const update = this.#db.prepare(`
        UPDATE jobs SET row_version = row_version + 1, lease_expires_at_ms = ?, updated_at_ms = ?
        WHERE job_id = ? AND status IN ('running', 'cancelling') AND lease_token = ? AND row_version = ?
      `).run(nowMs + this.#options.leaseMs, nowMs, jobId, leaseToken, expectedVersion);
      if (update.changes !== 1) {
        throw new AppError("lease_lost", `Lease was lost for ${jobId}`);
      }
      this.#appendEvent(jobId, "heartbeat", {}, nowMs);
      return rowToJob(this.#jobRow(jobId));
    });
  }

  requestCancellation(jobId: string, reason?: string, nowMs = Date.now()): JobSnapshot {
    return this.#immediate(() => {
      const row = this.#jobRow(jobId);
      if (isTerminalStatus(row.status) || row.status === "cancelling") {
        return rowToJob(row);
      }
      if (row.status === "queued") {
        const update = this.#db.prepare(`
          UPDATE jobs SET status = 'cancelled', row_version = row_version + 1,
            cancellation_reason = ?, updated_at_ms = ?, terminal_at_ms = ?
          WHERE job_id = ? AND status = 'queued' AND row_version = ?
        `).run(reason ?? null, nowMs, nowMs, jobId, row.row_version);
        if (update.changes !== 1) {
          throw new AppError("invalid_transition", `Concurrent cancellation update for ${jobId}`);
        }
        this.#appendEvent(jobId, "cancelled", reason === undefined ? {} : { reason }, nowMs);
        return rowToJob(this.#jobRow(jobId));
      }
      assertTransition(row.status, "cancelling");
      const update = this.#db.prepare(`
        UPDATE jobs SET status = 'cancelling', row_version = row_version + 1,
          cancellation_reason = ?, updated_at_ms = ?
        WHERE job_id = ? AND status = ? AND row_version = ?
      `).run(reason ?? null, nowMs, jobId, row.status, row.row_version);
      if (update.changes !== 1) {
        throw new AppError("invalid_transition", `Concurrent cancellation update for ${jobId}`);
      }
      this.#appendEvent(jobId, "cancellation_requested", reason === undefined ? {} : { reason }, nowMs);
      return rowToJob(this.#jobRow(jobId));
    });
  }

  transition(input: TransitionInput): JobSnapshot {
    const nowMs = input.nowMs ?? Date.now();
    return this.#immediate(() => {
      const row = this.#jobRow(input.jobId);
      if (row.status !== input.expectedStatus) {
        throw new AppError("invalid_transition", `Expected ${input.expectedStatus}, found ${row.status}`);
      }
      assertTransition(row.status, input.nextStatus);
      if (input.leaseToken !== undefined && row.lease_token !== input.leaseToken) {
        throw new AppError("lease_lost", `Lease was lost for ${input.jobId}`);
      }
      const terminalAt = isTerminalStatus(input.nextStatus) ? nowMs : null;
      const updates = input.updates;
      const update = this.#db.prepare(`
        UPDATE jobs SET
          status = ?, row_version = row_version + 1, updated_at_ms = ?, terminal_at_ms = ?,
          result_status = COALESCE(?, result_status), result_json = COALESCE(?, result_json),
          decision_id = COALESCE(?, decision_id), transcript_path = COALESCE(?, transcript_path),
          recovery_reason = COALESCE(?, recovery_reason)
        WHERE job_id = ? AND status = ? AND row_version = ?
          AND (? IS NULL OR lease_token = ?)
      `).run(
        input.nextStatus,
        nowMs,
        terminalAt,
        updates?.resultStatus ?? null,
        updates?.resultJson === undefined ? null : canonicalJson(updates.resultJson),
        updates?.decisionId ?? null,
        updates?.transcriptPath ?? null,
        updates?.recoveryReason ?? null,
        input.jobId,
        input.expectedStatus,
        input.expectedVersion,
        input.leaseToken ?? null,
        input.leaseToken ?? null,
      );
      if (update.changes !== 1) {
        throw new AppError("lease_lost", `Guarded transition failed for ${input.jobId}`);
      }
      this.#appendEvent(input.jobId, input.eventType, input.eventPayload ?? {}, nowMs);
      return rowToJob(this.#jobRow(input.jobId));
    });
  }

  commitDecisionResult(input: DecisionCommitInput): JobSnapshot {
    const nowMs = input.nowMs ?? Date.now();
    return this.#immediate(() => {
      const row = this.#jobRow(input.jobId);
      if (
        row.status !== "running" ||
        row.row_version !== input.expectedVersion ||
        row.lease_token !== input.leaseToken
      ) {
        throw new AppError("lease_lost", `Cannot publish decision for ${input.jobId}`);
      }
      if (row.request_fingerprint !== input.requestFingerprint) {
        throw new AppError("decision_publication_failed", "Request fingerprint mismatch");
      }
      const existingOrigin = this.#db.prepare<[string], { decision_id: string }>(`
        SELECT decision_id FROM decision_origins WHERE job_id = ?
      `).get(input.jobId);
      if (existingOrigin !== undefined) {
        throw new AppError(
          "decision_publication_conflict",
          `Job ${input.jobId} already published ${existingOrigin.decision_id}`,
        );
      }
      const resultJson = canonicalJson(input.resultJson);
      const update = this.#db.prepare(`
        UPDATE jobs SET
          status = 'succeeded', row_version = row_version + 1, result_status = ?,
          result_json = ?, transcript_path = ?, terminal_at_ms = ?, updated_at_ms = ?
        WHERE job_id = ? AND status = 'running' AND row_version = ? AND lease_token = ?
      `).run(
        input.resultStatus,
        resultJson,
        input.transcriptPath,
        nowMs,
        nowMs,
        input.jobId,
        input.expectedVersion,
        input.leaseToken,
      );
      if (update.changes !== 1) {
        throw new AppError("lease_lost", `Publication guard failed for ${input.jobId}`);
      }
      this.#db.prepare(`
        INSERT INTO workspaces(id, canonical_root, created_at_ms) VALUES (?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(input.workspaceId, input.canonicalRoot, nowMs);
      const request = startDeliberationInputSchema.parse(JSON.parse(row.canonical_request_json));
      const threadId = resolveContinuationThread({
        db: this.#db,
        workspaceId: input.workspaceId,
        ...(request.continuation_id === undefined
          ? {}
          : { continuationId: request.continuation_id }),
        nowMs,
      });
      this.#db.prepare(`
        INSERT INTO decisions(
          id, workspace_id, thread_id, question, protocol, result_status, outcome_status,
          canonical_json, summary, execution_isolation, review_due_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.packet.decision_id,
        input.workspaceId,
        threadId,
        input.packet.question,
        input.packet.protocol,
        input.resultStatus,
        input.packet.ballot.outcome,
        canonicalJson(parseJsonValue(input.packet)),
        input.summary,
        input.packet.execution_isolation,
        input.packet.review_due_at_ms,
        input.packet.created_at_ms,
        nowMs,
      );
      this.#db.prepare(`
        INSERT INTO decision_origins(job_id, decision_id, request_fingerprint, committed_at_ms)
        VALUES (?, ?, ?, ?)
      `).run(input.jobId, input.packet.decision_id, input.requestFingerprint, nowMs);
      this.#db.prepare("UPDATE jobs SET decision_id = ? WHERE job_id = ?").run(
        input.packet.decision_id,
        input.jobId,
      );
      for (const participant of input.packet.participants) {
        const selection = input.packet.committee_selection.find(
          (item) => item.participant_id === participant.participant_id,
        );
        this.#db.prepare(`
          INSERT INTO decision_participants(
            workspace_id, decision_id, participant_id, adapter, model, provider_family,
            reasoning_effort, selection_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.workspaceId,
          input.packet.decision_id,
          participant.participant_id,
          participant.cli,
          participant.model,
          selection?.provider_family ?? participant.cli,
          participant.reasoning_effort ?? null,
          selection === undefined ? null : canonicalJson(parseJsonValue(selection)),
        );
      }
      for (const claim of input.packet.claims) {
        this.#db.prepare(`
          INSERT INTO claims(
            id, workspace_id, decision_id, participant_id, claim_type, text, confidence, created_at_ms
          ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
        `).run(
          claim.claim_id,
          input.workspaceId,
          input.packet.decision_id,
          claim.type,
          claim.text,
          claim.confidence,
          nowMs,
        );
      }
      for (const prediction of input.packet.predictions) {
        this.#db.prepare(`
          INSERT INTO claims(
            id, workspace_id, decision_id, participant_id, claim_type, text, confidence, created_at_ms
          ) VALUES (?, ?, ?, ?, 'prediction', ?, ?, ?)
        `).run(
          prediction.prediction_id,
          input.workspaceId,
          input.packet.decision_id,
          prediction.participant_id,
          prediction.statement,
          prediction.probability,
          nowMs,
        );
        this.#db.prepare(`
          INSERT INTO predictions(
            id, workspace_id, decision_id, claim_id, participant_id, adapter, model, domain,
            probability, target_date, resolution_criteria
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          prediction.prediction_id,
          input.workspaceId,
          input.packet.decision_id,
          prediction.prediction_id,
          prediction.participant_id,
          prediction.adapter,
          prediction.model,
          prediction.domain,
          prediction.probability,
          prediction.target_date,
          prediction.resolution_criteria,
        );
      }
      for (const evidence of input.packet.evidence) {
        this.#db.prepare(`
          INSERT INTO evidence(
            id, workspace_id, decision_id, source_type, canonical_uri, locator, content_hash,
            captured_commit_sha, captured_at_ms, tool_or_adapter, execution_isolation,
            redaction_status, expires_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          evidence.evidence_id,
          input.workspaceId,
          input.packet.decision_id,
          evidence.source_type,
          evidence.canonical_uri,
          evidence.locator ?? null,
          evidence.content_hash,
          evidence.captured_commit_sha ?? null,
          evidence.captured_at_ms,
          evidence.tool_or_adapter,
          evidence.execution_isolation,
          evidence.redaction_status,
          evidence.expires_at_ms ?? null,
        );
        if (evidence.claim_id !== undefined) {
          this.#db.prepare(`
            INSERT INTO claim_evidence(workspace_id, claim_id, evidence_id, polarity, is_critical)
            VALUES (?, ?, ?, ?, 0)
          `).run(
            input.workspaceId,
            evidence.claim_id,
            evidence.evidence_id,
            evidence.polarity,
          );
        }
      }
      this.#db.prepare(`
        INSERT INTO derived_operations(
          operation_key, operation_type, decision_id, status, created_at_ms, updated_at_ms
        ) VALUES (?, 'similarity_index', ?, 'queued', ?, ?)
      `).run(`similarity:${input.packet.decision_id}`, input.packet.decision_id, nowMs, nowMs);
      this.#appendEvent(input.jobId, "completed", {
        result_status: input.resultStatus,
        decision_id: input.packet.decision_id,
      }, nowMs);
      return rowToJob(this.#jobRow(input.jobId));
    });
  }

  events(jobId: string, afterSeq = 0, limit = 100): JobEvent[] {
    return this.#db.prepare<[string, number, number], EventRow>(`
      SELECT * FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?
    `).all(jobId, afterSeq, Math.min(Math.max(limit, 1), 500)).map((row) =>
      jobEventSchema.parse({
        job_id: row.job_id,
        seq: row.seq,
        event_type: row.event_type,
        payload: parseJsonValue(JSON.parse(row.payload_json)),
        created_at_ms: row.created_at_ms,
      }),
    );
  }

  attempts(jobId: string): JobAttempt[] {
    return this.#db
      .prepare<[string], AttemptRow>(`
        SELECT * FROM job_attempts WHERE job_id = ? ORDER BY created_at_ms, attempt_id
      `)
      .all(jobId)
      .map((row) => rowToAttempt(row));
  }

  createAttempt(input: CreateAttemptInput): JobAttempt {
    const nowMs = input.nowMs ?? Date.now();
    return this.#immediate(() => {
      const existing = this.#db.prepare<
        [string, string, string, string, string],
        AttemptRow
      >(`
        SELECT * FROM job_attempts
        WHERE job_id = ? AND stage_id = ? AND participant_id = ?
          AND attempt_kind = ? AND request_digest = ?
        ORDER BY ordinal DESC LIMIT 1
      `).get(
        input.jobId,
        input.stageId,
        input.participantId,
        input.attemptKind,
        input.requestDigest,
      );
      if (
        existing !== undefined &&
        (existing.status === "succeeded" ||
          existing.status === "pending" ||
          existing.status === "started")
      ) {
        return rowToAttempt(existing);
      }
      const ordinal = existing === undefined ? input.ordinal : existing.ordinal + 1;
      const attemptId = randomUUID();
      this.#db.prepare(`
        INSERT INTO job_attempts(
          attempt_id, job_id, stage_id, participant_id, attempt_kind, ordinal,
          request_digest, status, execution_isolation, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        attemptId,
        input.jobId,
        input.stageId,
        input.participantId,
        input.attemptKind,
        ordinal,
        input.requestDigest,
        input.executionIsolation,
        nowMs,
      );
      const inserted = this.#db
        .prepare<[string], AttemptRow>("SELECT * FROM job_attempts WHERE attempt_id = ?")
        .get(attemptId);
      if (inserted === undefined) {
        throw new AppError("attempt_not_found", attemptId);
      }
      return rowToAttempt(inserted);
    });
  }

  markAttemptStarted(attemptId: string, externalStarted: boolean, nowMs = Date.now()): JobAttempt {
    const update = this.#db.prepare(`
      UPDATE job_attempts SET status = 'started', external_started = ?, started_at_ms = ?
      WHERE attempt_id = ? AND status = 'pending'
    `).run(externalStarted ? 1 : 0, nowMs, attemptId);
    if (update.changes !== 1) {
      throw new AppError("invalid_attempt_transition", `Cannot start attempt ${attemptId}`);
    }
    const row = this.#db.prepare<[string], AttemptRow>("SELECT * FROM job_attempts WHERE attempt_id = ?").get(attemptId);
    if (row === undefined) {
      throw new AppError("attempt_not_found", attemptId);
    }
    return rowToAttempt(row);
  }

  finishAttempt(
    attemptId: string,
    statusInput: AttemptStatus,
    details: FinishAttemptDetails = {},
    nowMs = Date.now(),
  ): JobAttempt {
    const status = attemptStatusSchema.parse(statusInput);
    if (status === "pending" || status === "started") {
      throw new AppError("invalid_attempt_transition", `${status} is not terminal`);
    }
    const update = this.#db.prepare(`
      UPDATE job_attempts SET status = ?, response_id = ?, response_digest = ?, raw_response = ?,
        error_type = ?, error_message = ?, latency_ms = ?, input_tokens = ?, output_tokens = ?,
        cost_usd = ?, terminal_at_ms = ?
      WHERE attempt_id = ? AND status IN ('pending', 'started')
    `).run(
      status,
      details.responseId ?? null,
      details.responseDigest ?? null,
      details.rawResponse ?? null,
      details.errorType ?? null,
      details.errorMessage ?? null,
      details.latencyMs ?? null,
      details.inputTokens ?? null,
      details.outputTokens ?? null,
      details.costUsd ?? null,
      nowMs,
      attemptId,
    );
    if (update.changes !== 1) {
      throw new AppError("invalid_attempt_transition", `Cannot finish attempt ${attemptId}`);
    }
    const row = this.#db.prepare<[string], AttemptRow>("SELECT * FROM job_attempts WHERE attempt_id = ?").get(attemptId);
    if (row === undefined) {
      throw new AppError("attempt_not_found", attemptId);
    }
    return rowToAttempt(row);
  }

  saveCheckpoint(jobId: string, stageId: string, state: JsonValue, nowMs = Date.now()): number {
    const stateJson = canonicalJson(state);
    const digest = createHash("sha256").update(stateJson).digest("hex");
    return this.#immediate(() => {
      const latest = this.#db
        .prepare<[string], { checkpoint_seq: number }>(
          "SELECT checkpoint_seq FROM job_checkpoints WHERE job_id = ? ORDER BY checkpoint_seq DESC LIMIT 1",
        )
        .get(jobId);
      const sequence = (latest?.checkpoint_seq ?? 0) + 1;
      this.#db.prepare(`
        INSERT OR IGNORE INTO job_checkpoints(job_id, checkpoint_seq, stage_id, state_json, state_digest, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(jobId, sequence, stageId, stateJson, digest, nowMs);
      return sequence;
    });
  }

  latestCheckpoint(jobId: string): JsonValue | undefined {
    const row = this.#db.prepare<[string], { state_json: string }>(`
      SELECT state_json FROM job_checkpoints WHERE job_id = ? ORDER BY checkpoint_seq DESC LIMIT 1
    `).get(jobId);
    return row === undefined ? undefined : parseJsonValue(JSON.parse(row.state_json));
  }

  recoverStale(nowMs = Date.now()): { jobId: string; action: string }[] {
    const stale = this.#db.prepare<[number], JobRow>(`
      SELECT * FROM jobs
      WHERE status IN ('dispatching', 'running')
        AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms < ?
      ORDER BY created_at_ms, job_id
    `).all(nowMs);
    const recovered: { jobId: string; action: string }[] = [];
    for (const staleRow of stale) {
      const action = this.#immediate(() => {
        const row = this.#jobRow(staleRow.job_id);
        if (row.row_version !== staleRow.row_version || row.status !== staleRow.status) {
          return "concurrent_update";
        }
        if (row.status === "dispatching") {
          const update = this.#db.prepare(`
            UPDATE jobs SET status = 'queued', row_version = row_version + 1,
              lease_token = NULL, lease_expires_at_ms = NULL, dispatch_token = NULL,
              updated_at_ms = ?
            WHERE job_id = ? AND status = 'dispatching' AND row_version = ?
          `).run(nowMs, row.job_id, row.row_version);
          if (update.changes !== 1) return "concurrent_update";
          this.#appendEvent(row.job_id, "stale_dispatch_requeued", {}, nowMs);
          return "requeued_dispatch";
        }
        const openAttempt = this.#db.prepare<[string], AttemptRow>(`
          SELECT * FROM job_attempts
          WHERE job_id = ? AND status = 'started' AND external_started = 1
          ORDER BY created_at_ms, attempt_id LIMIT 1
        `).get(row.job_id);
        if (openAttempt !== undefined) {
          this.#db.prepare(`
            UPDATE job_attempts SET status = 'uncertain', terminal_at_ms = ?
            WHERE attempt_id = ? AND status = 'started'
          `).run(nowMs, openAttempt.attempt_id);
          const update = this.#db.prepare(`
            UPDATE jobs SET status = 'recovery_required', row_version = row_version + 1,
              recovery_reason = 'uncertain_external_attempt', updated_at_ms = ?
            WHERE job_id = ? AND status = 'running' AND row_version = ?
          `).run(nowMs, row.job_id, row.row_version);
          if (update.changes !== 1) return "concurrent_update";
          this.#appendEvent(row.job_id, "recovery_required", {
            attempt_id: openAttempt.attempt_id,
            reason: "uncertain_external_attempt",
          }, nowMs);
          return "recovery_required";
        }
        const checkpoint = this.#db.prepare<[string], { present: number }>(`
          SELECT 1 AS present FROM job_checkpoints WHERE job_id = ? LIMIT 1
        `).get(row.job_id);
        const nextStatus = checkpoint === undefined ? "recovery_required" : "queued";
        const reason = checkpoint === undefined ? "missing_checkpoint" : null;
        const update = this.#db.prepare(`
          UPDATE jobs SET status = ?, row_version = row_version + 1, recovery_reason = ?,
            lease_token = NULL, lease_expires_at_ms = NULL, dispatch_token = NULL, updated_at_ms = ?
          WHERE job_id = ? AND status = 'running' AND row_version = ?
        `).run(nextStatus, reason, nowMs, row.job_id, row.row_version);
        if (update.changes !== 1) return "concurrent_update";
        this.#appendEvent(
          row.job_id,
          nextStatus === "queued" ? "checkpoint_requeued" : "recovery_required",
          reason === null ? {} : { reason },
          nowMs,
        );
        return nextStatus === "queued" ? "requeued_checkpoint" : "recovery_required";
      });
      if (action !== "concurrent_update") {
        recovered.push({ jobId: staleRow.job_id, action });
      }
    }
    return recovered;
  }

  runningProcesses(jobId: string): RunningProcess[] {
    return this.#db.prepare<[string], ProcessRow>(`
      SELECT process_id, pid, pid_started_at_ms, process_group_id
      FROM job_processes WHERE job_id = ? AND status = 'running'
      ORDER BY created_at_ms, process_id
    `).all(jobId).map((row) => ({
      processId: row.process_id,
      pid: row.pid,
      startedAtMs: row.pid_started_at_ms,
      ...(row.process_group_id === null ? {} : { processGroupId: row.process_group_id }),
    }));
  }

  registerProcess(input: {
    jobId: string;
    attemptId?: string;
    pid: number;
    pidStartedAtMs: number;
    processGroupId?: number;
    role: "supervisor" | "worker" | "adapter";
    nowMs?: number;
  }): string {
    const processId = randomUUID();
    const nowMs = input.nowMs ?? Date.now();
    this.#db.prepare(`
      INSERT INTO job_processes(
        process_id, job_id, attempt_id, pid, pid_started_at_ms, process_group_id, role, status, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)
    `).run(
      processId,
      input.jobId,
      input.attemptId ?? null,
      input.pid,
      input.pidStartedAtMs,
      input.processGroupId ?? null,
      input.role,
      nowMs,
    );
    return processId;
  }

  markProcessExited(processId: string, cleanupUncertain = false, nowMs = Date.now()): void {
    const update = this.#db.prepare(`
      UPDATE job_processes SET status = ?, exited_at_ms = ?
      WHERE process_id = ? AND status = 'running'
    `).run(cleanupUncertain ? "cleanup_uncertain" : "exited", nowMs, processId);
    if (update.changes !== 1) {
      throw new AppError("process_not_found", `Running process not found: ${processId}`);
    }
  }

  markAttemptProcessesExited(
    attemptId: string,
    cleanupUncertain = false,
    nowMs = Date.now(),
  ): number {
    return this.#db.prepare(`
      UPDATE job_processes SET status = ?, exited_at_ms = ?
      WHERE attempt_id = ? AND status = 'running'
    `).run(cleanupUncertain ? "cleanup_uncertain" : "exited", nowMs, attemptId).changes;
  }

  recordQuality(sample: QualitySample): QualityMetric {
    const nowMs = sample.nowMs ?? Date.now();
    return this.#immediate(() => {
      const current = this.#db.prepare<[string, string, string], QualityRow>(`
        SELECT * FROM quality_metrics WHERE adapter = ? AND model = ? AND domain = ?
      `).get(sample.adapter, sample.model, sample.domain);
      const latencies = current === undefined
        ? []
        : z.array(z.number().int().nonnegative()).parse(JSON.parse(current.latency_samples_json));
      if (sample.latencyMs !== undefined) {
        latencies.push(sample.latencyMs);
        if (latencies.length > 50) {
          latencies.splice(0, latencies.length - 50);
        }
      }
      this.#db.prepare(`
        INSERT INTO quality_metrics(
          adapter, model, domain, attempts, valid_attempts, valid_ballots, abstentions, failures,
          latency_samples_json, input_tokens, output_tokens, cost_usd, resolved_predictions, brier_sum, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(adapter, model, domain) DO UPDATE SET
          attempts = attempts + excluded.attempts,
          valid_attempts = valid_attempts + excluded.valid_attempts,
          valid_ballots = valid_ballots + excluded.valid_ballots,
          abstentions = abstentions + excluded.abstentions,
          failures = failures + excluded.failures,
          latency_samples_json = excluded.latency_samples_json,
          input_tokens = input_tokens + excluded.input_tokens,
          output_tokens = output_tokens + excluded.output_tokens,
          cost_usd = CASE
            WHEN excluded.cost_usd IS NULL THEN cost_usd
            ELSE COALESCE(cost_usd, 0) + excluded.cost_usd
          END,
          resolved_predictions = resolved_predictions + excluded.resolved_predictions,
          brier_sum = brier_sum + excluded.brier_sum,
          updated_at_ms = excluded.updated_at_ms
      `).run(
        sample.adapter,
        sample.model,
        sample.domain,
        sample.countAttempt === false ? 0 : 1,
        sample.valid_attempt === true ? 1 : 0,
        sample.valid_ballot === true ? 1 : 0,
        sample.abstention === true ? 1 : 0,
        sample.failure === true ? 1 : 0,
        JSON.stringify(latencies),
        sample.inputTokens ?? 0,
        sample.outputTokens ?? 0,
        sample.costUsd ?? null,
        sample.resolvedPrediction === true ? 1 : 0,
        sample.brierScore ?? 0,
        nowMs,
      );
      const stored = this.#db.prepare<[string, string, string], QualityRow>(`
        SELECT * FROM quality_metrics WHERE adapter = ? AND model = ? AND domain = ?
      `).get(sample.adapter, sample.model, sample.domain);
      if (stored === undefined) {
        throw new AppError("quality_metric_not_found", `Missing metric for ${sample.adapter}/${sample.model}`);
      }
      return rowToQuality(stored);
    });
  }

  listQuality(filters: { adapter?: string; model?: string; domain?: string } = {}): QualityMetric[] {
    const conditions: string[] = [];
    const parameters: string[] = [];
    for (const [column, value] of [
      ["adapter", filters.adapter],
      ["model", filters.model],
      ["domain", filters.domain],
    ] as const) {
      if (value !== undefined) {
        conditions.push(`${column} = ?`);
        parameters.push(value);
      }
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    return this.#db
      .prepare<string[], QualityRow>(`
        SELECT * FROM quality_metrics ${where} ORDER BY adapter, model, domain
      `)
      .all(...parameters)
      .map((row) => rowToQuality(row));
  }

  resumeRecovery(
    jobId: string,
    policy: "retry" | "cancel",
    nowMs = Date.now(),
  ): JobSnapshot {
    return this.#immediate(() => {
      const row = this.#jobRow(jobId);
      if (row.status !== "recovery_required") {
        throw new AppError("invalid_transition", `Job ${jobId} does not require recovery`);
      }
      const nextStatus = policy === "retry" ? "queued" : "cancelled";
      assertTransition(row.status, nextStatus);
      const update = this.#db.prepare(`
        UPDATE jobs SET
          status = ?, row_version = row_version + 1, lease_token = NULL,
          lease_expires_at_ms = NULL, dispatch_token = NULL, updated_at_ms = ?,
          terminal_at_ms = ?
        WHERE job_id = ? AND status = 'recovery_required' AND row_version = ?
      `).run(
        nextStatus,
        nowMs,
        nextStatus === "cancelled" ? nowMs : null,
        jobId,
        row.row_version,
      );
      if (update.changes !== 1) {
        throw new AppError("invalid_transition", `Concurrent recovery update for ${jobId}`);
      }
      this.#appendEvent(
        jobId,
        nextStatus === "queued" ? "recovery_resumed" : "recovery_cancelled",
        { uncertain_attempt_policy: policy },
        nowMs,
      );
      return rowToJob(this.#jobRow(jobId));
    });
  }

  purgeTerminalJobs(nowMs: number, retentionMs: number): number {
    const result = this.#db.prepare(`
      DELETE FROM jobs
      WHERE status IN ('succeeded', 'failed', 'cancelled')
        AND terminal_at_ms IS NOT NULL AND terminal_at_ms < ?
    `).run(nowMs - retentionMs);
    return result.changes;
  }
}
