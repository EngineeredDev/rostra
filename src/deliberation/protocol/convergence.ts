import { z } from "zod/v4";
import { AppError } from "../../errors.js";
import type { SimilarityProvider } from "../../similarity/provider.js";

export const positionSnapshotSchema = z.strictObject({
  participantId: z.string().min(1),
  position: z.string().min(1),
  vote: z.string().min(1).optional(),
});

export type PositionSnapshot = z.infer<typeof positionSnapshotSchema>;

interface ConvergenceInput {
  participantIds: readonly string[];
  checks: readonly (readonly PositionSnapshot[])[];
  requiredStableChecks: number;
  similarity: (left: string, right: string) => number;
  agreementThreshold: number;
}

export const convergenceReportSchema = z.strictObject({
  within_model_stability: z.number().finite(),
  cross_model_agreement: z.number().finite(),
  vote_stability: z.number().finite(),
  disagreement_streak: z.number().int().nonnegative(),
  impasse: z.boolean(),
  progress: z.strictObject({
    checks: z.number().int().nonnegative(),
    comparisons: z.number().int().nonnegative(),
    quorum_required: z.number().int().nonnegative(),
    valid_votes: z.number().int().nonnegative(),
    options: z.array(z.string()),
  }),
});

export type ConvergenceReport = z.infer<typeof convergenceReportSchema>;

function indexedSnapshot(
  participantIds: readonly string[],
  snapshot: readonly PositionSnapshot[],
): Map<string, PositionSnapshot> {
  const indexed = new Map<string, PositionSnapshot>();
  for (const position of snapshot) {
    if (!participantIds.includes(position.participantId)) {
      throw new AppError("unknown_participant", position.participantId);
    }
    if (indexed.has(position.participantId)) {
      throw new AppError("duplicate_participant", position.participantId);
    }
    indexed.set(position.participantId, position);
  }
  const missing = participantIds.filter((participantId) => !indexed.has(participantId));
  if (missing.length > 0) {
    throw new AppError("missing_participant", missing.join(", "));
  }
  return indexed;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function analyzeConvergence(input: ConvergenceInput): ConvergenceReport {
  if (new Set(input.participantIds).size !== input.participantIds.length) {
    throw new AppError("duplicate_participant", "Participant identities must be unique");
  }
  const indexed = input.checks.map((snapshot) => indexedSnapshot(input.participantIds, snapshot));
  const withinScores: number[] = [];
  const voteScores: number[] = [];
  let disagreementStreak = 0;
  const quorum = Math.ceil((2 * input.participantIds.length) / 3);

  for (let index = 1; index < indexed.length; index += 1) {
    const previous = indexed[index - 1];
    const current = indexed[index];
    if (previous === undefined || current === undefined) {
      throw new AppError("invalid_convergence_state", "Convergence snapshot is missing");
    }
    const transitionScores = input.participantIds.map((participantId) => {
      const before = previous.get(participantId);
      const after = current.get(participantId);
      if (before === undefined || after === undefined) {
        throw new AppError("missing_participant", participantId);
      }
      return input.similarity(before.position, after.position);
    });
    withinScores.push(...transitionScores);
    const stable = transitionScores.every((score) => score >= input.agreementThreshold);
    const voteMatches = input.participantIds.filter((participantId) =>
      previous.get(participantId)?.vote === current.get(participantId)?.vote,
    ).length;
    voteScores.push(voteMatches / input.participantIds.length);
    const votes = input.participantIds
      .map((participantId) => current.get(participantId)?.vote)
      .filter((vote): vote is string => vote !== undefined);
    const tally: Record<string, number> = {};
    for (const vote of votes) {
      tally[vote] = (tally[vote] ?? 0) + 1;
    }
    const maximum = Math.max(0, ...Object.values(tally));
    const split = votes.length >= quorum && Object.keys(tally).length >= 2 && maximum < quorum;
    disagreementStreak = stable && split ? disagreementStreak + 1 : 0;
  }

  const current = indexed.at(-1);
  const crossScores: number[] = [];
  if (current !== undefined) {
    for (let left = 0; left < input.participantIds.length; left += 1) {
      for (let right = left + 1; right < input.participantIds.length; right += 1) {
        const leftPosition = current.get(input.participantIds[left] ?? "");
        const rightPosition = current.get(input.participantIds[right] ?? "");
        if (leftPosition === undefined || rightPosition === undefined) {
          throw new AppError("missing_participant", "Cross-model comparison identity is missing");
        }
        crossScores.push(input.similarity(leftPosition.position, rightPosition.position));
      }
    }
  }
  const currentVotes = input.participantIds
    .map((participantId) => current?.get(participantId)?.vote)
    .filter((vote): vote is string => vote !== undefined);
  return {
    within_model_stability: average(withinScores),
    cross_model_agreement: average(crossScores),
    vote_stability: average(voteScores),
    disagreement_streak: disagreementStreak,
    impasse: disagreementStreak >= input.requiredStableChecks,
    progress: {
      checks: indexed.length,
      comparisons: withinScores.length + crossScores.length,
      quorum_required: quorum,
      valid_votes: currentVotes.length,
      options: [...new Set(currentVotes)].sort(),
    },
  };
}

export async function analyzeSemanticConvergence(input: {
  participantIds: readonly string[];
  checks: readonly (readonly PositionSnapshot[])[];
  requiredStableChecks: number;
  provider: SimilarityProvider;
}): Promise<ConvergenceReport> {
  const positions = [...new Set(input.checks.flatMap((check) =>
    check.map((snapshot) => snapshot.position)))];
  const vectors = await input.provider.embed(positions);
  if (vectors.length !== positions.length) {
    throw new AppError("embedding_count_mismatch", "Similarity provider returned the wrong vector count");
  }
  const byPosition = new Map(positions.map((position, index) => [position, vectors[index] ?? []]));
  return analyzeConvergence({
    participantIds: input.participantIds,
    checks: input.checks,
    requiredStableChecks: input.requiredStableChecks,
    agreementThreshold: input.provider.agreementThreshold,
    similarity: (left, right) => input.provider.similarity(
      byPosition.get(left) ?? [],
      byPosition.get(right) ?? [],
    ),
  });
}

export function shouldStopProtocol(
  policy: "continue" | "qualified_decision" | "impasse",
  report: ConvergenceReport | undefined,
  consensusReached: boolean,
): boolean {
  return (policy === "impasse" && report?.impasse === true) ||
    (policy === "qualified_decision" && consensusReached);
}
