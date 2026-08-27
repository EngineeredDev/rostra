import type { StageKind } from "../config/schema.js";
import type { DecisionOption } from "../contracts/common.js";

interface PriorResponse {
  participantId: string;
  rawText: string;
}

interface StagePromptInput {
  question: string;
  stageKind: StageKind;
  visibility: "question_only" | "anonymized_prior" | "full_prior";
  priorResponses: readonly PriorResponse[];
  decisionOptions?: readonly DecisionOption[];
  stance?: string;
  allowedCapabilities?: readonly string[];
}

const claimId = "11111111-1111-4111-8111-111111111111";
const outputInstructions: Record<StageKind, string> = {
  independent_analysis: '{"claims":[],"assumptions":[],"recommendation":"...","confidence":0.0,"predictions":[]}',
  critique: `{"target_claim_ids":["${claimId}"],"objection":"...","evidence_request":"..."}`,
  proposal: '{"claims":[],"assumptions":[],"recommendation":"...","confidence":0.0,"predictions":[]}',
  adversarial_attack: `{"target_claim_ids":["${claimId}"],"objection":"...","evidence_request":"..."}`,
  defense: '{"claims":[],"assumptions":[],"recommendation":"...","confidence":0.0,"predictions":[]}',
  anonymous_aggregate: '{"agreements":[],"disagreements":[],"unresolved_claim_ids":[]}',
  revision: '{"claims":[],"assumptions":[],"recommendation":"...","confidence":0.0,"predictions":[]}',
  premortem: '{"claims":[],"assumptions":[],"recommendation":"...","confidence":0.0,"predictions":[]}',
  evidence_collection: `{"claim_id":"${claimId}","evidence_requests":[],"evidence_ids":[],"assessment":"..."}`,
  cross_examination: `{"target_claim_ids":["${claimId}"],"objection":"...","evidence_request":"..."}`,
  adjudication: `{"claim_id":"${claimId}","verdict":"unknown","rationale":"...","evidence_ids":[]}`,
  experiment_proposal: '{"hypothesis":"...","discriminating_metric":"...","setup":"...","commands":[],"expected_outcomes":[],"estimated_cost":"...","safety_notes":[],"required_capabilities":[]}',
  final_ballot: '{"option_id":"option-id","confidence":0.0,"rationale":"...","continue_debate":false}',
};

export function buildStagePrompt(input: StagePromptInput): string {
  const lines = [
    `Question: ${input.question}`,
    `Stage: ${input.stageKind}`,
  ];
  if (input.decisionOptions !== undefined) {
    lines.push(
      "Decision options (use the ID in option_id):",
      ...input.decisionOptions.map((option) => `- ${option.id}: ${option.label}`),
    );
  }
  if (input.stance !== undefined) lines.push(`Assigned stance: ${input.stance}`);
  if (input.visibility !== "question_only" && input.priorResponses.length > 0) {
    lines.push("Prior responses:");
    for (const [index, response] of [...input.priorResponses]
      .sort((left, right) => left.participantId.localeCompare(right.participantId))
      .entries()) {
      lines.push(input.visibility === "full_prior"
        ? `Participant ${response.participantId}: ${response.rawText}`
        : `P${index + 1}: ${response.rawText}`);
    }
  }
  if (input.allowedCapabilities !== undefined && input.allowedCapabilities.length > 0) {
    lines.push(
      `Allowed evidence operations: ${[...input.allowedCapabilities].sort().join(", ")}.`,
      "To inspect evidence, return one line and no final result:",
      'AI_COUNSEL_TOOL_REQUEST: {"name":"read_file","arguments":{"path":"relative/path"},"claim_id":"optional-UUID","polarity":"supports"}',
      "After AI_COUNSEL_TOOL_RESULT, use its evidence_id in the final structured result.",
    );
  }
  lines.push(
    "Return your analysis as plain text.",
    "End the response with exactly one structured result line.",
    `AI_COUNSEL_RESULT: ${outputInstructions[input.stageKind]}`,
  );
  return lines.join("\n\n");
}
