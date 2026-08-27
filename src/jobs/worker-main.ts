#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { z } from "zod/v4";
import { loadConfig } from "../config/loader.js";
import { ConfiguredProtocolRunner } from "../deliberation/runner.js";
import { AppError, errorMessage } from "../errors.js";
import { runWorker } from "./worker.js";

const workerArgumentsSchema = z.strictObject({
  database: z.string().min(1),
  config: z.string().min(1),
  jobId: z.uuid(),
  dispatchToken: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
});

export function parseWorkerArguments(argv: readonly string[]): z.infer<typeof workerArgumentsSchema> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) {
      throw new AppError("invalid_worker_arguments", "Worker arguments must be --name value pairs");
    }
    values[flag.slice(2)] = value;
  }
  return workerArgumentsSchema.parse({
    database: values.database,
    config: values.config,
    jobId: values["job-id"],
    dispatchToken: values["dispatch-token"],
    expectedVersion: Number(values["expected-version"]),
  });
}


async function main(): Promise<void> {
  const arguments_ = parseWorkerArguments(process.argv.slice(2));
  const config = await loadConfig(arguments_.config);
  await runWorker({
    databasePath: arguments_.database,
    config,
    jobId: arguments_.jobId,
    dispatchToken: arguments_.dispatchToken,
    expectedVersion: arguments_.expectedVersion,
    runner: new ConfiguredProtocolRunner({ config, databasePath: arguments_.database }),
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
