import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "@huggingface/transformers";
import { z } from "zod/v4";
import { sha256File } from "../utils/hash-file.js";
import { AppError, errorMessage } from "../errors.js";
import { BaseSimilarityProvider } from "./provider.js";

const manifestSchema = z.strictObject({
  model: z.string().min(1),
  revision: z.string().min(1),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});
const vectorsSchema = z.array(z.array(z.number()));

export type EmbeddingFunction = (texts: readonly string[]) => Promise<number[][]>;

interface LocalMiniLmOptions {
  modelDirectory: string;
  agreementThreshold: number;
  retrievalThreshold: number;
  thresholdsRevision: string;
  embedderFactory?: () => Promise<EmbeddingFunction>;
}


export async function loadMiniLmManifest(): Promise<z.infer<typeof manifestSchema>> {
  return manifestSchema.parse(
    JSON.parse(await readFile(new URL("./models/minilm-manifest.json", import.meta.url), "utf8")),
  );
}

export class LocalMiniLmProvider extends BaseSimilarityProvider {
  readonly #modelDirectory: string;
  readonly #embedderFactory?: () => Promise<EmbeddingFunction>;
  #embedder?: EmbeddingFunction;

  constructor(options: LocalMiniLmOptions) {
    super({
      provider: "local_minilm",
      endpoint: "local",
      model: "sentence-transformers/all-MiniLM-L6-v2",
      revision: "1110a243fdf4706b3f48f1d95db1a4f5529b4d41",
      thresholdsRevision: options.thresholdsRevision,
      agreementThreshold: options.agreementThreshold,
      retrievalThreshold: options.retrievalThreshold,
    });
    this.#modelDirectory = options.modelDirectory;
    if (options.embedderFactory !== undefined) {
      this.#embedderFactory = options.embedderFactory;
    }
  }

  async initialize(): Promise<void> {
    const manifest = await loadMiniLmManifest();
    try {
      for (const [path, expected] of Object.entries(manifest.files)) {
        if ((await sha256File(join(this.#modelDirectory, path))) !== expected) {
          throw new Error(`Digest mismatch: ${path}`);
        }
      }
    } catch (error) {
      throw new AppError("similarity_model_unavailable", errorMessage(error));
    }
    try {
      if (this.#embedderFactory !== undefined) {
        this.#embedder = await this.#embedderFactory();
        return;
      }
      const extractor = await pipeline("feature-extraction", this.#modelDirectory, {
        local_files_only: true,
      });
      this.#embedder = async (texts: readonly string[]): Promise<number[][]> => {
        const tensor = await extractor([...texts], { pooling: "mean", normalize: true });
        const raw: unknown = tensor.tolist();
        return vectorsSchema.parse(raw);
      };
    } catch (error) {
      throw new AppError("similarity_model_unavailable", errorMessage(error));
    }
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (this.#embedder === undefined) {
      throw new AppError("similarity_model_unavailable", "Local MiniLM is not initialized");
    }
    return this.#embedder(texts);
  }
}
