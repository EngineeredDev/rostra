#!/usr/bin/env node
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod/v4";
import { initialize } from "./init.js";
import { loadConfig } from "../config/loader.js";
import { resolveConfigPath, resolveDataHome } from "../config/paths.js";
import { DecisionCiReviewer } from "../decision-ci/review.js";
import { renderSarif } from "../decision-ci/sarif.js";
import { reviewDecisionChangeInputSchema } from "../contracts/tools.js";
import { AppError, errorMessage } from "../errors.js";
import { JobStore } from "../jobs/store.js";
import { runHttpServer } from "../mcp/http.js";
import { runMcpServer } from "../mcp/main.js";
import { openStorage } from "../storage/database.js";
import { fetchPinnedMiniLm } from "../similarity/fetch-model.js";
import { PACKAGE_VERSION } from "../version.js";

async function openJobStore(): Promise<JobStore> {
  const configPath = await resolveConfigPath();
  const config = await loadConfig(configPath);
  const db = await openStorage(join(resolveDataHome(), "rostra.sqlite"), {
    busyTimeoutMs: config.storage.busy_timeout_ms,
  });
  return new JobStore(db, {
    dedupeSuccessMs: config.jobs.dedupe_success_ms,
    leaseMs: config.jobs.lease_ms,
  });
}

async function runJobs(args: readonly string[]): Promise<void> {
  const store = await openJobStore();
  try {
    if (args[0] === "list") {
      process.stdout.write(`${JSON.stringify(store.list({ limit: 100 }), null, 2)}\n`);
      return;
    }
    if (args[0] === "cancel" && args[1] !== undefined) {
      process.stdout.write(`${JSON.stringify(store.requestCancellation(args[1]), null, 2)}\n`);
      return;
    }
    throw new AppError("invalid_command", "Usage: rostra jobs list|cancel <job-id>");
  } finally {
    store.close();
  }
}

async function runDecision(args: readonly string[]): Promise<void> {
  if (args[0] !== "review") {
    throw new AppError("invalid_command", "Usage: rostra decision review [options]");
  }
  const values: Record<string, string> = {};
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) {
      throw new AppError("invalid_command", "Decision review options require --name value pairs");
    }
    values[flag.slice(2)] = value;
  }
  const workingDirectory = values["working-directory"];
  const baseRef = values.base;
  const headRef = values.head;
  const format = values.format ?? "text";
  const failOn = values["fail-on"] ?? "warning";
  if (workingDirectory === undefined || baseRef === undefined || headRef === undefined) {
    throw new AppError(
      "invalid_command",
      "Decision review requires --working-directory, --base, and --head",
    );
  }
  if (!["text", "json", "sarif"].includes(format)) {
    throw new AppError("invalid_command", `Unknown output format: ${format}`);
  }
  const configPath = await resolveConfigPath();
  const config = await loadConfig(configPath);
  const db = await openStorage(join(resolveDataHome(), "rostra.sqlite"), {
    busyTimeoutMs: config.storage.busy_timeout_ms,
  });
  try {
    const reviewer = new DecisionCiReviewer(db);
    const result = await reviewer.review(reviewDecisionChangeInputSchema.parse({
      working_directory: workingDirectory,
      base_ref: baseRef,
      head_ref: headRef,
      fail_on: failOn,
    }));
    if (format === "json") {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (format === "sarif") {
      process.stdout.write(`${JSON.stringify(renderSarif(result, PACKAGE_VERSION), null, 2)}\n`);
    } else {
      const lines = result.findings.map((finding) =>
        `${finding.severity} ${finding.finding_type}: ${finding.remediation}`,
      );
      process.stdout.write(`${lines.length === 0 ? "No findings." : lines.join("\n")}\n`);
    }
    if (result.threshold_met) {
      process.exitCode = 2;
    }
  } finally {
    db.close();
  }
}

const serveOptionsSchema = z.strictObject({
  transport: z.enum(["http", "stdio"]).default("http"),
  host: z.string().trim().min(1).optional(),
  port: z.number().int().min(1).max(65_535).optional(),
});

export type ServeOptions = z.infer<typeof serveOptionsSchema>;

export function parseServeArgs(args: readonly string[]): ServeOptions {
  const values: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--http" || flag === "--stdio") {
      values.transport = flag.slice(2);
      continue;
    }
    if (flag === "--host" || flag === "--port") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new AppError("invalid_command", `${flag} requires a value`);
      }
      values[flag.slice(2)] = flag === "--port" ? Number(value) : value;
      index += 1;
      continue;
    }
    throw new AppError("invalid_command", `Unknown serve option: ${flag ?? ""}`);
  }
  const parsed = serveOptionsSchema.safeParse(values);
  if (!parsed.success) {
    throw new AppError("invalid_command", "Usage: rostra serve [--http|--stdio] [--host H] [--port N]");
  }
  return parsed.data;
}

async function runServe(args: readonly string[]): Promise<void> {
  const options = parseServeArgs(args);
  if (options.transport === "stdio") {
    await runMcpServer();
    return;
  }
  const handle = await runHttpServer({
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
  });
  process.stdout.write(`rostra listening on ${handle.url}\n`);
}

export async function runCli(args: readonly string[]): Promise<void> {
  if (args.length === 0) {
    await runMcpServer();
    return;
  }
  if (args[0] === "init") {
    if (args.length !== 1) {
      throw new AppError("invalid_command", "Usage: rostra init");
    }
    const result = await initialize();
    const lines = [
      `${result.configCreated ? "Created" : "Kept existing"} configuration: ${result.configPath}`,
      `Data directory: ${result.dataHome}`,
    ];
    if (result.modelDirectory !== undefined) {
      lines.push(`Similarity model: ${result.modelDirectory}`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }
  if (args[0] === "jobs") {
    await runJobs(args.slice(1));
    return;
  }
  if (args[0] === "models" && args[1] === "fetch" && args.length === 2) {
    const modelDirectory = await fetchPinnedMiniLm(resolveDataHome());
    process.stdout.write(`${modelDirectory}\n`);
    return;
  }
  if (args[0] === "decision") {
    await runDecision(args.slice(1));
    return;
  }
  if (args[0] === "serve") {
    await runServe(args.slice(1));
    return;
  }
  throw new AppError("invalid_command", `Unknown command: ${args.join(" ")}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
