import type { DecisionPacket } from "../contracts/results.js";
import { renderDecisionSummary } from "../summary/render.js";

interface TranscriptResponse {
  stageId: string;
  participantId: string;
  rawText: string;
}

export function renderTranscript(
  packet: DecisionPacket,
  responses: readonly TranscriptResponse[],
): string {
  const lines = [
    "# Decision Transcript",
    "",
    `Decision ID: ${packet.decision_id}`,
    `Job ID: ${packet.job_id}`,
    `Protocol: ${packet.protocol}`,
    `Question: ${packet.question}`,
    "",
    "## Decision Summary",
    "",
    renderDecisionSummary(packet),
    "",
    "## Raw Stage Responses",
  ];
  for (const response of [...responses].sort(
    (left, right) =>
      left.stageId.localeCompare(right.stageId) ||
      left.participantId.localeCompare(right.participantId),
  )) {
    lines.push("", `### ${response.stageId} — ${response.participantId}`, "", response.rawText);
  }
  lines.push(
    "",
    "## Authoritative Final Projection",
    "",
    "```json",
    JSON.stringify({ ballot: packet.ballot, convergence: packet.convergence }, null, 2),
    "```",
    "",
  );
  return lines.join("\n");
}
