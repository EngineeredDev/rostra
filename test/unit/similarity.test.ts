import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMiniLmManifest, LocalMiniLmProvider } from "../../src/similarity/local-minilm.js";
import { OpenAiCompatibleEmbeddingProvider } from "../../src/similarity/openai-compatible.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("explicit similarity providers", () => {
  it("fails corrupt local artifacts before constructing the embedder", async () => {
    const root = await mkdtemp(join(tmpdir(), "rostra-similarity-"));
    roots.push(root);
    await mkdir(join(root, "onnx"), { recursive: true });
    for (const path of [
      "config.json",
      "special_tokens_map.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "vocab.txt",
      "onnx/model.onnx",
    ]) {
      await writeFile(join(root, path), "corrupt");
    }
    let constructed = false;
    const provider = new LocalMiniLmProvider({
      manifest: await loadMiniLmManifest(),
      modelDirectory: root,
      agreementThreshold: 0.8,
      retrievalThreshold: 0.7,
      thresholdsRevision: "test",
      embedderFactory: () => {
        constructed = true;
        return Promise.resolve(() => Promise.resolve([[1, 0]]));
      },
    });
    await expect(provider.initialize()).rejects.toMatchObject({
      code: "similarity_model_unavailable",
    });
    expect(constructed).toBe(false);
  });

  it("maps remote embeddings and keys cache identity by calibrated thresholds", async () => {
    const requests: string[] = [];
    const fetchMock: typeof fetch = (resource) => {
      requests.push(
        resource instanceof URL
          ? resource.href
          : typeof resource === "string"
            ? resource
            : resource.url,
      );
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { index: 0, embedding: [1, 0] },
              { index: 1, embedding: [0, 1] },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    };
    const provider = new OpenAiCompatibleEmbeddingProvider({
      baseUrl: "https://embedding.test",
      model: "embed-a",
      apiKeyEnvironment: "EMBED_KEY",
      agreementThreshold: 0.8,
      retrievalThreshold: 0.7,
      thresholdsRevision: "remote-v1",
      environment: { EMBED_KEY: "secret" },
      fetch: fetchMock,
    });
    await provider.initialize();
    await expect(provider.embed(["a", "b"])).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(provider.similarity([1, 0], [0, 1])).toBe(0);
    expect(requests).toEqual(["https://embedding.test/v1/embeddings"]);
    expect(provider.cacheKey("same")).not.toBe(
      new OpenAiCompatibleEmbeddingProvider({
        baseUrl: "https://embedding.test",
        model: "embed-a",
        apiKeyEnvironment: "EMBED_KEY",
        agreementThreshold: 0.81,
        retrievalThreshold: 0.7,
        thresholdsRevision: "remote-v1",
        environment: { EMBED_KEY: "secret" },
        fetch: fetchMock,
      }).cacheKey("same"),
    );
  });
});
