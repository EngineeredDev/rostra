import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/storage", { recursive: true });
await mkdir("dist/similarity/models", { recursive: true });
await mkdir("dist/process", { recursive: true });
await cp("src/storage/schema.sql", "dist/storage/schema.sql");
await cp(
  "src/similarity/models/minilm-manifest.json",
  "dist/similarity/models/minilm-manifest.json",
);
await cp("src/process/gate.mjs", "dist/process/gate.mjs");
await cp("config.example.yaml", "dist/config.example.yaml");
