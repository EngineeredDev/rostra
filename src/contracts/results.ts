import { z } from "zod/v4";
import {
  executionIsolationSchema,
  nonemptyStringSchema,
  participantSchema,
  slugSchema,
  uuidSchema,
} from "./common.js";
import { convergenceReportSchema } from "../deliberation/protocol/convergence.js";
import { claimDraftSchema, experimentProposalSchema, predictionSchema } from "./submissions.js";

export const decisionPredictionSchema = predictionSchema.extend({
  prediction_id: uuidSchema,
  participant_id: slugSchema,
  adapter: slugSchema,
  model: nonemptyStringSchema,
  domain: slugSchema,
});

export const ballotOutcomeSchema = z.enum([
  "unanimous",
  "qualified_majority",
  "plurality",
  "tie",
  "insufficient_quorum",
  "no_ballots",
  "impasse",
]);

export const ballotRecordSchema = z.strictObject({
  participant_id: slugSchema,
  stage_id: slugSchema,
  option_id: slugSchema.optional(),
  option_label: nonemptyStringSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  rationale: nonemptyStringSchema.optional(),
  valid: z.boolean(),
  failure_reason: nonemptyStringSchema.optional(),
});

export const ballotProjectionSchema = z.strictObject({
  outcome: ballotOutcomeSchema,
  consensus_reached: z.boolean(),
  participant_count: z.number().int().nonnegative(),
  quorum_required: z.number().int().nonnegative(),
  valid_ballots: z.number().int().nonnegative(),
  abstentions: z.number().int().nonnegative(),
  final_tally: z.record(slugSchema, z.number().int().nonnegative()),
  winner: slugSchema.optional(),
  minority_reports: z.array(
    z.strictObject({
      option_id: slugSchema,
      votes: z.number().int().positive(),
      rationale: nonemptyStringSchema,
    }),
  ),
  ballot_history: z.array(ballotRecordSchema),
});

export const evidenceRecordSchema = z.strictObject({
  evidence_id: uuidSchema,
  claim_id: uuidSchema.optional(),
  source_type: z.enum(["file", "git", "adapter", "external", "outcome"]),
  canonical_uri: nonemptyStringSchema,
  locator: nonemptyStringSchema.optional(),
  content_hash: nonemptyStringSchema,
  captured_commit_sha: nonemptyStringSchema.optional(),
  captured_at_ms: z.number().int().nonnegative(),
  tool_or_adapter: nonemptyStringSchema,
  execution_isolation: executionIsolationSchema,
  redaction_status: z.enum(["none", "redacted"]),
  polarity: z.enum(["supports", "refutes", "neutral"]),
  expires_at_ms: z.number().int().nonnegative().optional(),
});

export const committeeSelectionRecordSchema = z.strictObject({
  participant_id: slugSchema,
  provider_family: nonemptyStringSchema,
  estimated_cost_usd: z.number().nonnegative().nullable(),
  estimated_latency_ms: z.number().nonnegative(),
  score: z.number(),
  score_breakdown: z.strictObject({
    calibration: z.number(),
    success_rate: z.number(),
    provider_family_novelty: z.number(),
    cost_latency_efficiency: z.number(),
  }),
  selection_reason: nonemptyStringSchema,
});

export const decisionPacketSchema = z.strictObject({
  decision_id: uuidSchema,
  job_id: uuidSchema,
  question: nonemptyStringSchema,
  protocol: slugSchema,
  participants: z.array(participantSchema),
  committee_selection: z.array(committeeSelectionRecordSchema).default([]),
  committee_limited: z.boolean().default(false),
  ballot: ballotProjectionSchema,
  convergence: convergenceReportSchema,
  claims: z.array(claimDraftSchema),
  evidence: z.array(evidenceRecordSchema),
  predictions: z.array(decisionPredictionSchema),
  agreements: z.array(nonemptyStringSchema),
  assumptions: z.array(nonemptyStringSchema),
  unresolved_claims: z.array(nonemptyStringSchema),
  failed_participants: z.array(slugSchema).default([]),
  experiment_proposals: z.array(experimentProposalSchema),
  execution_isolation: executionIsolationSchema,
  created_at_ms: z.number().int().nonnegative(),
  review_due_at_ms: z.number().int().nonnegative(),
});

export const deliberationResultSchema = z.strictObject({
  status: z.enum(["complete", "partial"]),
  decision: decisionPacketSchema,
  summary: nonemptyStringSchema,
  transcript_path: nonemptyStringSchema,
  failed_participants: z.array(slugSchema),
  execution_isolation: executionIsolationSchema,
});
export type CommitteeSelectionRecord = z.infer<typeof committeeSelectionRecordSchema>;

export type BallotOutcome = z.infer<typeof ballotOutcomeSchema>;
export type BallotRecord = z.infer<typeof ballotRecordSchema>;
export type BallotProjection = z.infer<typeof ballotProjectionSchema>;
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;
export type DecisionPacket = z.infer<typeof decisionPacketSchema>;
export type DeliberationResult = z.infer<typeof deliberationResultSchema>;
