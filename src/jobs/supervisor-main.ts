#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { z } from "zod/v4";
import { loadConfig } from "../config/loader.js";
import { AppError, errorMessage } from "../errors.js";
import { runSupervisor } from "./supervisor.js";

const supervisorArgumentsSchema = z.strictObject({
  database: z.string().min(1),
  config: z.string().min(1),
  ownerToken: z.string().min(1),
  buildId: z.string().min(1),
  configDigest: z.string().min(1),
  workerEntrypoint: z.string().min(1),
});

function parseArguments(argv: readonly string[]): z.infer<typeof supervisorArgumentsSchema> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) {
      throw new AppError("invalid_supervisor_arguments", "Arguments must be --name value pairs");
    }
    values[flag.slice(2)] = value;
  }
  return supervisorArgumentsSchema.parse({
    database: values.database,
    config: values.config,
    ownerToken: values["owner-token"],
    buildId: values["build-id"],
    configDigest: values["config-digest"],
    workerEntrypoint: values["worker-entrypoint"],
  });
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const config = await loadConfig(arguments_.config);
  await runSupervisor({
    databasePath: arguments_.database,
    configPath: arguments_.config,
    config,
    ownerToken: arguments_.ownerToken,
    buildId: arguments_.buildId,
    configDigest: arguments_.configDigest,
    workerEntrypoint: arguments_.workerEntrypoint,
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
