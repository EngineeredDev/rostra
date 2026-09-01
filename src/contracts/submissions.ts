import { z } from "zod/v4";
import { stageKindSchema, type StageKind } from "../config/schema.js";
import { AppError, errorMessage } from "../errors.js";
import { nonemptyStringSchema, slugSchema, uuidSchema } from "./common.js";

export const predictionSchema = z.strictObject({
  statement: nonemptyStringSchema,
  probability: z.number().min(0).max(1),
  target_date: z.iso.datetime(),
  resolution_criteria: nonemptyStringSchema,
});

export const claimDraftSchema = z.strictObject({
  claim_id: uuidSchema,
  type: z.enum(["fact", "assumption", "prediction", "risk", "recommendation"]),
  text: nonemptyStringSchema,
  confidence: z.number().min(0).max(1),
});

export const analysisSubmissionSchema = z.strictObject({
  claims: z.array(claimDraftSchema),
  assumptions: z.array(nonemptyStringSchema),
  recommendation: nonemptyStringSchema,
  confidence: z.number().min(0).max(1),
  predictions: z.array(predictionSchema).default([]),
});

export const critiqueSubmissionSchema = z.strictObject({
  target_claim_ids: z.array(uuidSchema).min(1),
  objection: nonemptyStringSchema,
  evidence_request: nonemptyStringSchema.optional(),
});

export const ballotSubmissionSchema = z.strictObject({
  option_id: slugSchema.optional(),
  option_label: nonemptyStringSchema.optional(),
  confidence: z.number().min(0).max(1),
  rationale: nonemptyStringSchema,
  continue_debate: z.boolean(),
}).refine((value) => value.option_id !== undefined || value.option_label !== undefined, {
  message: "A ballot requires option_id or option_label",
});

export const evidenceSubmissionSchema = z.strictObject({
  claim_id: uuidSchema,
  evidence_requests: z.array(nonemptyStringSchema),
  evidence_ids: z.array(uuidSchema),
  assessment: nonemptyStringSchema,
});

export const adjudicationSubmissionSchema = z.strictObject({
  claim_id: uuidSchema,
  verdict: z.enum(["supported", "refuted", "unknown"]),
  rationale: nonemptyStringSchema,
  evidence_ids: z.array(uuidSchema),
});

export const experimentProposalSchema = z.strictObject({
  hypothesis: nonemptyStringSchema,
  discriminating_metric: nonemptyStringSchema,
  setup: nonemptyStringSchema,
  commands: z.array(nonemptyStringSchema),
  expected_outcomes: z.array(nonemptyStringSchema),
  estimated_cost: nonemptyStringSchema,
  safety_notes: z.array(nonemptyStringSchema),
  required_capabilities: z.array(slugSchema),
});

export const anonymousAggregateSchema = z.strictObject({
  agreements: z.array(nonemptyStringSchema),
  disagreements: z.array(nonemptyStringSchema),
  unresolved_claim_ids: z.array(uuidSchema),
});


export const stageSubmissionSchemas = {
  independent_analysis: analysisSubmissionSchema,
  critique: critiqueSubmissionSchema,
  proposal: analysisSubmissionSchema,
  adversarial_attack: critiqueSubmissionSchema,
  defense: analysisSubmissionSchema,
  anonymous_aggregate: anonymousAggregateSchema,
  revision: analysisSubmissionSchema,
  premortem: analysisSubmissionSchema,
  evidence_collection: evidenceSubmissionSchema,
  cross_examination: critiqueSubmissionSchema,
  adjudication: adjudicationSubmissionSchema,
  experiment_proposal: experimentProposalSchema,
  final_ballot: ballotSubmissionSchema,
} satisfies Record<StageKind, z.ZodType>;

export interface ExtractedSubmission {
  raw_text: string;
  submission: unknown;
}

export function extractStageSubmission(kind: StageKind, rawText: string): ExtractedSubmission {
  stageKindSchema.parse(kind);
  const marker = "ROSTRA_RESULT:";
  const markerIndex = rawText.lastIndexOf(marker);
  if (markerIndex < 0 || rawText.slice(markerIndex + marker.length).trim() === "") {
    throw new AppError("invalid_stage_result", `Stage ${kind} did not end with ${marker}`);
  }
  const jsonText = rawText.slice(markerIndex + marker.length).trim();
  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch (error) {
    throw new AppError("invalid_stage_result", `Stage ${kind} returned invalid JSON: ${errorMessage(error)}`);
  }
  const schema = stageSubmissionSchemas[kind];
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError("invalid_stage_result", `Stage ${kind} result violated its contract`, parsed.error.issues);
  }
  return { raw_text: rawText, submission: parsed.data };
}

export type AnalysisSubmission = z.infer<typeof analysisSubmissionSchema>;
export type CritiqueSubmission = z.infer<typeof critiqueSubmissionSchema>;
export type BallotSubmission = z.infer<typeof ballotSubmissionSchema>;
export type ExperimentProposal = z.infer<typeof experimentProposalSchema>;

