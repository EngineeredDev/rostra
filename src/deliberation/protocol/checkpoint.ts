import { z } from "zod/v4";
import { stageKindSchema } from "../../config/schema.js";
import {
  executionIsolationSchema,
  participantSchema,
  slugSchema,
  uuidSchema,
} from "../../contracts/common.js";
import { committeeSelectionRecordSchema, evidenceRecordSchema } from "../../contracts/results.js";
import { convergenceReportSchema, positionSnapshotSchema } from "./convergence.js";

const stageDefinitionSchema = z.strictObject({
  id: slugSchema,
  kind: stageKindSchema,
  minimumCompletions: z.number().int().nonnegative(),
});

const stageResponseSchema = z.strictObject({
  participantId: slugSchema,
  responseId: z.string().min(1),
  rawText: z.string(),
  submission: z.json(),
});

export const protocolStateCheckpointSchema = z.strictObject({
  protocol: slugSchema,
  participantIds: z.array(slugSchema),
  stages: z.array(stageDefinitionSchema),
  currentStageIndex: z.number().int().nonnegative(),
  status: z.enum(["ready", "running", "completed", "failed"]),
  responses: z.record(slugSchema, z.record(slugSchema, stageResponseSchema)),
  completedStageIds: z.array(slugSchema),
  failure: z.string().optional(),
});

const completedResponseSchema = z.strictObject({
  stageId: slugSchema,
  stageKind: stageKindSchema,
  participantId: slugSchema,
  rawText: z.string(),
  submission: z.json(),
});

const rawBallotSchema = z.strictObject({
  participantId: slugSchema,
  optionId: slugSchema.optional(),
  optionLabel: z.string().optional(),
  rationale: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  failureReason: z.string().optional(),
});

const ballotStageSchema = z.strictObject({
  stageId: slugSchema,
  ordinal: z.number().int().nonnegative(),
  completed: z.boolean(),
  ballots: z.array(rawBallotSchema),
});

export const protocolCheckpointSchema = z.strictObject({
  protocol_state: protocolStateCheckpointSchema,
  completed_responses: z.array(completedResponseSchema),
  completed_attempts: z.array(
    z.strictObject({
      attempt_id: uuidSchema,
      request_digest: z.string().min(1),
    }),
  ),
  evidence_records: z.array(evidenceRecordSchema),
  selected_participants: z.array(participantSchema),
  committee_selection: z.array(committeeSelectionRecordSchema),
  committee_limited: z.boolean(),
  convergence_checks: z.array(z.array(positionSnapshotSchema)),
  convergence_report: convergenceReportSchema.optional(),
  ballot_stages: z.array(ballotStageSchema),
  ballot_projection: z.json().optional(),
  execution_isolation: executionIsolationSchema,
  failed_participants: z.array(slugSchema),
  next_stage: z.number().int().nonnegative(),
});

export type ProtocolCheckpoint = z.infer<typeof protocolCheckpointSchema>;
