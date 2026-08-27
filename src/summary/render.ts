import type { DecisionPacket } from "../contracts/results.js";

function section(title: string, values: readonly string[]): string[] {
  if (values.length === 0) {
    return [];
  }
  return [title, ...values.map((value) => `- ${value}`)];
}

export function renderDecisionSummary(packet: DecisionPacket): string {
  const lines = [
    `Outcome: ${packet.ballot.outcome}`,
    `Consensus reached: ${packet.ballot.consensus_reached ? "yes" : "no"}`,
    `Quorum: ${packet.ballot.valid_ballots}/${packet.ballot.quorum_required} required ballots (${packet.ballot.participant_count} participants)`,
    `Abstentions: ${packet.ballot.abstentions}`,
    `Semantic agreement: ${packet.convergence.cross_model_agreement.toFixed(3)}`,
    `Within-model stability: ${packet.convergence.within_model_stability.toFixed(3)}`,
    `Semantic impasse: ${packet.convergence.impasse ? "yes" : "no"}`,
    `Execution isolation: ${packet.execution_isolation}`,
  ];
  if (packet.ballot.winner !== undefined) {
    lines.push(`Leading option: ${packet.ballot.winner}`);
  }
  lines.push(
    ...section(
      "Final tally:",
      Object.entries(packet.ballot.final_tally)
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([option, votes]) => `${option}: ${votes}`),
    ),
    ...section("Agreements:", packet.agreements),
    ...section(
      "Minority reports:",
      packet.ballot.minority_reports.map((report) => `${report.option_id}: ${report.rationale}`),
    ),
    ...section("Assumptions:", packet.assumptions),
    ...section("Unresolved claims:", packet.unresolved_claims),
    ...section("Failed participants:", packet.failed_participants),
  );
  return lines.join("\n");
}
