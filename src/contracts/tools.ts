import { z } from "zod/v4";
import {
  cursorSchema,
  decisionOptionSchema,
  domainTagSchema,
  errorEnvelopeSchema,
  nonemptyStringSchema,
  participantSchema,
  slugSchema,
  uuidSchema,
} from "./common.js";
import { deliberationResultSchema } from "./results.js";

export const jobStatusSchema = z.enum([
  "queued",
  "dispatching",
  "running",
  "recovery_required",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
]);

const startShape = {
  question: nonemptyStringSchema,
  working_directory: nonemptyStringSchema,
  protocol: slugSchema,
  decision_options: z.array(decisionOptionSchema).min(2).optional(),
  continuation_id: uuidSchema.optional(),
  domain_tags: z.array(domainTagSchema).default([]),
  max_cost_usd: z.number().positive().optional(),
  deadline_seconds: z.number().int().min(1).max(86_400).optional(),
  allow_unknown_cost: z.boolean().default(false),
  session_models: z.record(slugSchema, nonemptyStringSchema).default({}),
  idempotency_key: z.string().trim().min(1).max(255).optional(),
  force_new: z.boolean().default(false),
  committee: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("explicit") }),
    z.strictObject({
      mode: z.literal("adaptive"),
      size: z.number().int().min(2).max(8),
      min_provider_families: z.number().int().min(1).max(8),
    }),
  ]),
  participants: z.array(participantSchema).min(2).max(8).optional(),
};

export const startDeliberationInputSchema = z
  .strictObject(startShape)
  .superRefine((value, context) => {
    const explicit = value.committee.mode === "explicit";
    if (explicit !== (value.participants !== undefined)) {
      context.addIssue({
        code: "custom",
        message: explicit
          ? "Explicit committees require participants"
          : "Adaptive committees prohibit participants",
        path: ["participants"],
      });
    }
    if (value.participants !== undefined) {
      const seen = new Set<string>();
      for (const participant of value.participants) {
        if (seen.has(participant.participant_id)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate participant_id: ${participant.participant_id}`,
            path: ["participants"],
          });
        }
        seen.add(participant.participant_id);
      }
    }
    const optionIds = value.decision_options?.map((option) => option.id) ?? [];
    if (new Set(optionIds).size !== optionIds.length) {
      context.addIssue({
        code: "custom",
        message: "Decision option IDs must be unique",
        path: ["decision_options"],
      });
    }
    if (new Set(value.domain_tags).size !== value.domain_tags.length) {
      context.addIssue({
        code: "custom",
        message: "Domain tags must be unique",
        path: ["domain_tags"],
      });
    }
  });

export const jobSubmissionSchema = z.strictObject({
  status: jobStatusSchema,
  job_id: uuidSchema,
  idempotency_key: z.string().optional(),
  deduplicated: z.boolean(),
  result: deliberationResultSchema.optional(),
});

export const jobActionSchema = z.strictObject({
  job_id: uuidSchema,
  status: jobStatusSchema,
});

export const listDeliberationsInputSchema = z.strictObject({
  statuses: z.array(jobStatusSchema).optional(),
  cursor: cursorSchema,
  limit: z.number().int().min(1).max(100).default(20),
  created_after: z.iso.datetime().optional(),
  created_before: z.iso.datetime().optional(),
});

export const jobSummarySchema = z.strictObject({
  job_id: uuidSchema,
  status: jobStatusSchema,
  question: nonemptyStringSchema,
  created_at_ms: z.number().int().nonnegative(),
  updated_at_ms: z.number().int().nonnegative(),
  result_status: z.enum(["complete", "partial"]).optional(),
});

export const listDeliberationsOutputSchema = z.strictObject({
  jobs: z.array(jobSummarySchema),
  next_cursor: z.string().optional(),
});

const jobSelectorShape = {
  job_id: uuidSchema.optional(),
  idempotency_key: z.string().trim().min(1).optional(),
};

export const getDeliberationInputSchema = z
  .strictObject({
    ...jobSelectorShape,
    wait_for_terminal: z.boolean().default(false),
    wait_timeout_seconds: z.number().positive().optional(),
    include_attempts: z.boolean().default(false),
  })
  .refine(
    (value) =>
      Number(value.job_id !== undefined) + Number(value.idempotency_key !== undefined) === 1,
    {
      message: "Exactly one job selector is required",
    },
  );

export const tailDeliberationInputSchema = z.strictObject({
  job_id: uuidSchema,
  after_seq: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(500).default(100),
  wait_for_change: z.boolean().default(false),
  wait_timeout_seconds: z.number().positive().optional(),
});

export const cancelDeliberationInputSchema = z.strictObject({
  job_id: uuidSchema,
  reason: nonemptyStringSchema.optional(),
});

export const resumeDeliberationInputSchema = z.strictObject({
  job_id: uuidSchema,
  uncertain_attempt_policy: z.enum(["retry", "cancel"]),
});

export const listModelsInputSchema = z.strictObject({ adapter: slugSchema.optional() });
export const setSessionModelsInputSchema = z.strictObject({
  models: z.record(slugSchema, nonemptyStringSchema.nullable()),
});
export const getQualityMetricsInputSchema = z.strictObject({
  adapter: slugSchema.optional(),
  model: nonemptyStringSchema.optional(),
  domain: slugSchema.optional(),
});

const decisionQueryCommon = {
  working_directory: nonemptyStringSchema,
  query_text: nonemptyStringSchema.optional(),
  decision_id: uuidSchema.optional(),
  continuation_id: uuidSchema.optional(),
  cursor: cursorSchema,
  limit: z.number().int().min(1).max(100).default(20),
  format: z.enum(["summary", "detailed", "json"]).default("summary"),
  include_stale: z.boolean().default(false),
  find_contradictions: z.boolean().default(false),
  threshold: z.number().min(0).max(1).optional(),
};

export const queryDecisionsInputSchema = z
  .strictObject(decisionQueryCommon)
  .refine(
    (value) =>
      Number(value.query_text !== undefined) +
        Number(value.decision_id !== undefined) +
        Number(value.continuation_id !== undefined) ===
      1,
    { message: "Exactly one decision selector is required" },
  );

export const listStaleDecisionsInputSchema = z.strictObject({
  working_directory: nonemptyStringSchema,
  cursor: cursorSchema,
  limit: z.number().int().min(1).max(100).default(20),
});

export const recordDecisionOutcomeInputSchema = z
  .strictObject({
    working_directory: nonemptyStringSchema,
    decision_id: uuidSchema,
    status: z.enum(["confirmed", "disconfirmed", "mixed", "superseded", "unknown"]),
    observed_at: z.iso.datetime(),
    measurements: z.record(z.string(), z.json()),
    notes: nonemptyStringSchema.optional(),
    superseding_decision_id: uuidSchema.optional(),
  })
  .superRefine((value, context) => {
    const requiresSuperseding = value.status === "superseded";
    if (requiresSuperseding !== (value.superseding_decision_id !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "superseding_decision_id is required only for superseded outcomes",
        path: ["superseding_decision_id"],
      });
    }
  });

export const reviewDecisionChangeInputSchema = z.strictObject({
  working_directory: nonemptyStringSchema,
  base_ref: nonemptyStringSchema,
  head_ref: nonemptyStringSchema,
  fail_on: z.enum(["none", "warning", "error"]).default("warning"),
});

export const decisionFindingSchema = z.strictObject({
  finding_type: z.enum([
    "stale_evidence",
    "changed_assumption",
    "conflicting_decision",
    "superseded_precedent",
    "outcome_regression",
  ]),
  severity: z.enum(["info", "warning", "error"]),
  decision_id: uuidSchema,
  claim_id: uuidSchema.optional(),
  evidence_id: uuidSchema.optional(),
  changed_paths: z.array(nonemptyStringSchema),
  provenance: z.record(z.string(), z.json()),
  remediation: nonemptyStringSchema,
  line: z.number().int().positive().optional(),
});

export const reviewDecisionChangeOutputSchema = z.strictObject({
  workspace_root: nonemptyStringSchema,
  base_sha: nonemptyStringSchema,
  head_sha: nonemptyStringSchema,
  findings: z.array(decisionFindingSchema),
  threshold_met: z.boolean(),
});

export const toolContracts = {
  start_deliberation: {
    input: startDeliberationInputSchema,
    output: z.union([jobSubmissionSchema, errorEnvelopeSchema]),
  },
  list_deliberations: {
    input: listDeliberationsInputSchema,
    output: z.union([listDeliberationsOutputSchema, errorEnvelopeSchema]),
  },
  get_deliberation: {
    input: getDeliberationInputSchema,
    output: z.union([z.record(z.string(), z.json()), errorEnvelopeSchema]),
  },
  tail_deliberation: {
    input: tailDeliberationInputSchema,
    output: z.union([z.record(z.string(), z.json()), errorEnvelopeSchema]),
  },
  cancel_deliberation: {
    input: cancelDeliberationInputSchema,
    output: z.union([jobActionSchema, errorEnvelopeSchema]),
  },
  resume_deliberation: {
    input: resumeDeliberationInputSchema,
    output: z.union([jobActionSchema, errorEnvelopeSchema]),
  },
  list_models: { input: listModelsInputSchema, output: z.record(z.string(), z.json()) },
  set_session_models: {
    input: setSessionModelsInputSchema,
    output: z.record(z.string(), z.json()),
  },
  get_quality_metrics: {
    input: getQualityMetricsInputSchema,
    output: z.record(z.string(), z.json()),
  },
  query_decisions: { input: queryDecisionsInputSchema, output: z.record(z.string(), z.json()) },
  list_stale_decisions: {
    input: listStaleDecisionsInputSchema,
    output: z.record(z.string(), z.json()),
  },
  record_decision_outcome: {
    input: recordDecisionOutcomeInputSchema,
    output: z.record(z.string(), z.json()),
  },
  review_decision_change: {
    input: reviewDecisionChangeInputSchema,
    output: z.union([reviewDecisionChangeOutputSchema, errorEnvelopeSchema]),
  },
} as const;

export type StartDeliberationInput = z.infer<typeof startDeliberationInputSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type JobSubmission = z.infer<typeof jobSubmissionSchema>;
export type QueryDecisionsInput = z.infer<typeof queryDecisionsInputSchema>;
export type ReviewDecisionChangeInput = z.infer<typeof reviewDecisionChangeInputSchema>;
export type DecisionFinding = z.infer<typeof decisionFindingSchema>;
export type ReviewDecisionChangeOutput = z.infer<typeof reviewDecisionChangeOutputSchema>;
