import { createHash } from "node:crypto";
import { canonicalJson, parseJsonValue } from "../utils/canonical-json.js";

export interface SimilarityProvider {
  readonly agreementThreshold: number;
  readonly retrievalThreshold: number;
  initialize(): Promise<void>;
  embed(texts: readonly string[]): Promise<number[][]>;
  similarity(left: readonly number[], right: readonly number[]): number;
  cacheKey(content: string): string;
}

interface SimilarityIdentity {
  provider: string;
  endpoint: string;
  model: string;
  revision: string;
  thresholdsRevision: string;
  agreementThreshold: number;
  retrievalThreshold: number;
}

export abstract class BaseSimilarityProvider implements SimilarityProvider {
  readonly agreementThreshold: number;
  readonly retrievalThreshold: number;
  readonly #identity: SimilarityIdentity;

  protected constructor(identity: SimilarityIdentity) {
    this.#identity = identity;
    this.agreementThreshold = identity.agreementThreshold;
    this.retrievalThreshold = identity.retrievalThreshold;
  }

  abstract initialize(): Promise<void>;
  abstract embed(texts: readonly string[]): Promise<number[][]>;

  similarity(left: readonly number[], right: readonly number[]): number {
    if (left.length === 0 || left.length !== right.length) {
      return 0;
    }
    let dot = 0;
    let leftMagnitude = 0;
    let rightMagnitude = 0;
    for (let index = 0; index < left.length; index += 1) {
      const leftValue = left[index] ?? 0;
      const rightValue = right[index] ?? 0;
      dot += leftValue * rightValue;
      leftMagnitude += leftValue * leftValue;
      rightMagnitude += rightValue * rightValue;
    }
    const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
    return denominator === 0 ? 0 : dot / denominator;
  }

  cacheKey(content: string): string {
    const contentHash = createHash("sha256").update(content).digest("hex");
    return createHash("sha256")
      .update(canonicalJson(parseJsonValue({ ...this.#identity, contentHash })))
      .digest("hex");
  }
}
