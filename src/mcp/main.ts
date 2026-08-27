import { join } from "node:path";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { computeBuildId, computeConfigDigest } from "../build-id.js";
import { loadConfig } from "../config/loader.js";
import { resolveConfigPath, resolveDataHome } from "../config/paths.js";
import { DecisionRepository } from "../decisions/repository.js";
import { DecisionCiReviewer } from "../decision-ci/review.js";
import { errorMessage } from "../errors.js";
import { JobStore } from "../jobs/store.js";
import { ensureSupervisor } from "../jobs/supervisor.js";
import { openStorage } from "../storage/database.js";
import { createMcpServer } from "./server.js";

export async function runMcpServer(): Promise<StdioServerHandle> {
  const configPath = await resolveConfigPath();
  const config = await loadConfig(configPath);
  const databasePath = join(resolveDataHome(), "ai-counsel.sqlite");
  const db = await openStorage(databasePath, {
    busyTimeoutMs: config.storage.busy_timeout_ms,
  });
  const store = new JobStore(db, {
    dedupeSuccessMs: config.jobs.dedupe_success_ms,
    leaseMs: config.jobs.lease_ms,
  });
  const decisions = new DecisionRepository(db);
  const reviewer = new DecisionCiReviewer(db);
  const [buildId, configDigest] = await Promise.all([
    computeBuildId(),
    computeConfigDigest(configPath),
  ]);
  const runtime = {
    config,
    store,
    decisions,
    reviewer,
    ensureSupervisor: async (): Promise<void> =>
      ensureSupervisor({
        db,
        databasePath,
        configPath,
        config,
        buildId,
        configDigest,
        ...(process.env.AI_COUNSEL_WORKER_ENTRYPOINT === undefined
          ? {}
          : { workerEntrypoint: process.env.AI_COUNSEL_WORKER_ENTRYPOINT }),
      }),
  };
  const handle = serveStdio(() => createMcpServer(runtime), {
    onerror: (error) => process.stderr.write(`${errorMessage(error)}\n`),
  });
  const close = (): void => {
    void handle.close().finally(() => store.close());
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return handle;
}
