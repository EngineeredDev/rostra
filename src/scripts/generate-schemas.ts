import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod/v4";
import { toolContracts } from "../contracts/tools.js";

const outputPath = join(process.cwd(), "docs", "generated", "tool-schemas.json");
const schemas = Object.fromEntries(
  Object.entries(toolContracts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, contract]) => [name, {
      input: z.toJSONSchema(contract.input),
      output: z.toJSONSchema(contract.output),
    }]),
);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify({ version: 2, tools: schemas }, null, 2)}\n`);
