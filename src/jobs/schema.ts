import { z } from "zod/v4";
import { executionIsolationSchema, nonemptyStringSchema, uuidSchema } from "../contracts/common.js";
import { jobStatusSchema, startDeliberationInputSchema } from "../contracts/tools.js";

export const jobSnapshotSchema = z.strictObject({
  job_id: uuidSchema,
  idempotency_key: z.string().optional(),
  request_fingerprint: nonemptyStringSchema,
  request: startDeliberationInputSchema,
  question: nonemptyStringSchema,
  status: jobStatusSchema,
  row_version: z.number().int().nonnegative(),
  lease_token: z.string().optional(),
  lease_expires_at_ms: z.number().int().nonnegative().optional(),
  dispatch_token: z.string().optional(),
  cancellation_reason: z.string().optional(),
  recovery_reason: z.string().optional(),
  result_status: z.enum(["complete", "partial"]).optional(),
  result_json: z.json().optional(),
  decision_id: uuidSchema.optional(),
  transcript_path: z.string().optional(),
  execution_isolation: executionIsolationSchema,
  build_id: z.string().optional(),
  config_digest: z.string().optional(),
  created_at_ms: z.number().int().nonnegative(),
  updated_at_ms: z.number().int().nonnegative(),
  terminal_at_ms: z.number().int().nonnegative().optional(),
});

export const jobEventSchema = z.strictObject({
  job_id: uuidSchema,
  seq: z.number().int().positive(),
  event_type: nonemptyStringSchema,
  payload: z.json(),
  created_at_ms: z.number().int().nonnegative(),
});

export const attemptStatusSchema = z.enum([
  "pending",
  "started",
  "succeeded",
  "failed",
  "uncertain",
  "cancelled",
]);

export const jobAttemptSchema = z.strictObject({
  attempt_id: uuidSchema,
  job_id: uuidSchema,
  stage_id: nonemptyStringSchema,
  participant_id: nonemptyStringSchema,
  attempt_kind: nonemptyStringSchema,
  ordinal: z.number().int().nonnegative(),
  request_digest: nonemptyStringSchema,
  status: attemptStatusSchema,
  external_started: z.boolean(),
  response_id: z.string().optional(),
  response_digest: z.string().optional(),
  raw_response: z.string().optional(),
  error_type: z.string().optional(),
  error_message: z.string().optional(),
  execution_isolation: executionIsolationSchema,
  latency_ms: z.number().int().nonnegative().optional(),
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
  started_at_ms: z.number().int().nonnegative().optional(),
  terminal_at_ms: z.number().int().nonnegative().optional(),
  created_at_ms: z.number().int().nonnegative(),
});

export type JobSnapshot = z.infer<typeof jobSnapshotSchema>;
export type JobEvent = z.infer<typeof jobEventSchema>;
export type AttemptStatus = z.infer<typeof attemptStatusSchema>;
export type JobAttempt = z.infer<typeof jobAttemptSchema>;
