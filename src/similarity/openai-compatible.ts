import { z } from "zod/v4";
import { AppError, errorMessage } from "../errors.js";
import { readBoundedResponseText } from "../utils/http.js";
import { BaseSimilarityProvider } from "./provider.js";

interface OpenAiCompatibleOptions {
  baseUrl: string;
  model: string;
  apiKeyEnvironment: string;
  agreementThreshold: number;
  retrievalThreshold: number;
  thresholdsRevision: string;
  environment?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  maximumResponseBytes?: number;
}

const responseSchema = z.strictObject({
  data: z.array(
    z.strictObject({
      index: z.number().int().nonnegative(),
      embedding: z.array(z.number()).min(1),
    }),
  ),
});

export class OpenAiCompatibleEmbeddingProvider extends BaseSimilarityProvider {
  readonly #endpoint: string;
  readonly #model: string;
  readonly #apiKeyEnvironment: string;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #fetch: typeof fetch;
  readonly #maximumResponseBytes: number;
  #apiKey?: string;

  constructor(options: OpenAiCompatibleOptions) {
    const endpoint = new URL(
      "v1/embeddings",
      options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`,
    ).href;
    super({
      provider: "openai_compatible",
      endpoint,
      model: options.model,
      revision: "remote",
      thresholdsRevision: options.thresholdsRevision,
      agreementThreshold: options.agreementThreshold,
      retrievalThreshold: options.retrievalThreshold,
    });
    this.#endpoint = endpoint;
    this.#model = options.model;
    this.#apiKeyEnvironment = options.apiKeyEnvironment;
    this.#environment = options.environment ?? process.env;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maximumResponseBytes = options.maximumResponseBytes ?? 4_194_304;
  }

  initialize(): Promise<void> {
    const secret = this.#environment[this.#apiKeyEnvironment];
    if (secret === undefined || secret === "") {
      throw new AppError("similarity_backend_unavailable", `Missing ${this.#apiKeyEnvironment}`);
    }
    this.#apiKey = secret;
    return Promise.resolve();
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (this.#apiKey === undefined) {
      throw new AppError("similarity_backend_unavailable", "Remote embeddings are not initialized");
    }
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify({ model: this.#model, input: texts }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = responseSchema.parse(
        JSON.parse(await readBoundedResponseText(response, this.#maximumResponseBytes)),
      );
      const ordered = [...payload.data].sort((left, right) => left.index - right.index);
      if (ordered.length !== texts.length) {
        throw new Error("Embedding count mismatch");
      }
      return ordered.map((item) => item.embedding);
    } catch (error) {
      throw new AppError("similarity_backend_unavailable", errorMessage(error));
    }
  }
}
