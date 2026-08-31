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

export type MiniLmManifest = z.infer<typeof manifestSchema>;
export type EmbeddingFunction = (texts: readonly string[]) => Promise<number[][]>;

interface LocalMiniLmOptions {
  manifest: MiniLmManifest;
  modelDirectory: string;
  agreementThreshold: number;
  retrievalThreshold: number;
  thresholdsRevision: string;
  embedderFactory?: () => Promise<EmbeddingFunction>;
}

interface LocalMiniLmInput {
  dataHome: string;
  agreementThreshold: number;
  retrievalThreshold: number;
  thresholdsRevision: string;
}

export async function loadMiniLmManifest(): Promise<MiniLmManifest> {
  return manifestSchema.parse(
    JSON.parse(await readFile(new URL("./models/minilm-manifest.json", import.meta.url), "utf8")),
  );
}

export function miniLmModelDirectory(dataHome: string, revision: string): string {
  return join(dataHome, "models", "minilm", revision);
}

// The manifest is the only pin: callers must not restate the revision, or a repin
// silently splits the fetch destination from the load path.
export async function createLocalMiniLmProvider(
  input: LocalMiniLmInput,
): Promise<LocalMiniLmProvider> {
  const manifest = await loadMiniLmManifest();
  return new LocalMiniLmProvider({
    manifest,
    modelDirectory: miniLmModelDirectory(input.dataHome, manifest.revision),
    agreementThreshold: input.agreementThreshold,
    retrievalThreshold: input.retrievalThreshold,
    thresholdsRevision: input.thresholdsRevision,
  });
}

export class LocalMiniLmProvider extends BaseSimilarityProvider {
  readonly #manifest: MiniLmManifest;
  readonly #modelDirectory: string;
  readonly #embedderFactory?: () => Promise<EmbeddingFunction>;
  #embedder?: EmbeddingFunction;

  constructor(options: LocalMiniLmOptions) {
    super({
      provider: "local_minilm",
      endpoint: "local",
      model: options.manifest.model,
      revision: options.manifest.revision,
      thresholdsRevision: options.thresholdsRevision,
      agreementThreshold: options.agreementThreshold,
      retrievalThreshold: options.retrievalThreshold,
    });
    this.#manifest = options.manifest;
    this.#modelDirectory = options.modelDirectory;
    if (options.embedderFactory !== undefined) {
      this.#embedderFactory = options.embedderFactory;
    }
  }

  async initialize(): Promise<void> {
    try {
      for (const [path, expected] of Object.entries(this.#manifest.files)) {
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
