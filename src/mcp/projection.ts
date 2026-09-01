import type { JobSnapshot } from "../jobs/schema.js";
import type { JobStore } from "../jobs/store.js";
import { parseJsonValue, type JsonValue } from "../utils/canonical-json.js";

export type JsonObject = Record<string, JsonValue>;

export const DELIBERATION_URI_PREFIX = "rostra://deliberations/";

/** The job resource and its event log: the pair a job change invalidates. */
export function deliberationUris(jobId: string): readonly string[] {
  return [`${DELIBERATION_URI_PREFIX}${jobId}`, `${DELIBERATION_URI_PREFIX}${jobId}/events`];
}

/** One projection of a job on the wire, shared by get_deliberation and the job resource. */
export function jobProjection(
  job: JobSnapshot,
  includeAttempts: boolean,
  store: JobStore,
): JsonObject {
  return {
    job_id: job.job_id,
    status: job.status,
    question: job.question,
    created_at_ms: job.created_at_ms,
    updated_at_ms: job.updated_at_ms,
    row_version: job.row_version,
    execution_isolation: job.execution_isolation,
    ...(job.result_status === undefined ? {} : { result_status: job.result_status }),
    ...(job.result_json === undefined ? {} : { result: job.result_json }),
    ...(job.decision_id === undefined ? {} : { decision_id: job.decision_id }),
    ...(job.transcript_path === undefined ? {} : { transcript_path: job.transcript_path }),
    ...(job.cancellation_reason === undefined
      ? {}
      : { cancellation_reason: job.cancellation_reason }),
    ...(job.recovery_reason === undefined ? {} : { recovery_reason: job.recovery_reason }),
    ...(includeAttempts
      ? { attempts: parseJsonValue(JSON.parse(JSON.stringify(store.attempts(job.job_id)))) }
      : {}),
  };
}
