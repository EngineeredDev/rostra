import { join } from "node:path";
import { computeBuildId, computeConfigDigest } from "../build-id.js";
import { loadConfig } from "../config/loader.js";
import { resolveConfigPath, resolveDataHome } from "../config/paths.js";
import type { Config } from "../config/schema.js";
import { DecisionCiReviewer } from "../decision-ci/review.js";
import { DecisionRepository } from "../decisions/repository.js";
import { AppError } from "../errors.js";
import { JobStore } from "../jobs/store.js";
import { ensureSupervisor } from "../jobs/supervisor.js";
import { openStorage } from "../storage/database.js";
import type { McpRuntime } from "./server.js";

export interface RostraRuntime {
  runtime: McpRuntime;
  store: JobStore;
  config: Config;
}

/**
 * Both entrypoints stamp the build id captured at startup onto every claimed job. A rebuild
 * underneath a long-lived server would dispatch work under a build that no longer exists on
 * disk, so refuse instead of silently adopting the new digests.
 */
async function assertBuildUnchanged(
  configPath: string,
  buildId: string,
  configDigest: string,
): Promise<void> {
  const [currentBuildId, currentConfigDigest] = await Promise.all([
    computeBuildId(),
    computeConfigDigest(configPath),
  ]);
  if (currentBuildId !== buildId || currentConfigDigest !== configDigest) {
    throw new AppError(
      "stale_server_build",
      "The build or configuration changed after this server started. Restart rostra before dispatching more work.",
    );
  }
}

/** Opens storage and assembles the runtime shared by the stdio and HTTP entrypoints. */
export async function createRuntime(): Promise<RostraRuntime> {
  const configPath = await resolveConfigPath();
  const config = await loadConfig(configPath);
  const databasePath = join(resolveDataHome(), "rostra.sqlite");
  const db = await openStorage(databasePath, {
    busyTimeoutMs: config.storage.busy_timeout_ms,
  });
  const store = new JobStore(db, {
    dedupeSuccessMs: config.jobs.dedupe_success_ms,
    leaseMs: config.jobs.lease_ms,
  });
  const [buildId, configDigest] = await Promise.all([
    computeBuildId(),
    computeConfigDigest(configPath),
  ]);
  const runtime: McpRuntime = {
    config,
    store,
    decisions: new DecisionRepository(db),
    reviewer: new DecisionCiReviewer(db),
    sessionModels: new Map<string, string>(),
    ensureSupervisor: async (): Promise<void> => {
      await assertBuildUnchanged(configPath, buildId, configDigest);
      await ensureSupervisor({
        db,
        databasePath,
        configPath,
        config,
        buildId,
        configDigest,
        ...(process.env.ROSTRA_WORKER_ENTRYPOINT === undefined
          ? {}
          : { workerEntrypoint: process.env.ROSTRA_WORKER_ENTRYPOINT }),
      });
    },
  };
  return { runtime, store, config };
}
