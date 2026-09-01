import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { startDeliberationInputSchema } from "../../src/contracts/tools.js";
import { JobStore } from "../../src/jobs/store.js";
import { ensureSupervisor } from "../../src/jobs/supervisor.js";
import type {
  CleanupStatus,
  ProcessIdentity,
  ProcessIdentityProvider,
} from "../../src/process/identity.js";
import { openStorage } from "../../src/storage/database.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FixedIdentityProvider implements ProcessIdentityProvider {
  terminated = false;

  identify(pid: number): Promise<ProcessIdentity | undefined> {
    return Promise.resolve({ pid, startedAtMs: 100 });
  }

  terminate(): Promise<CleanupStatus> {
    this.terminated = true;
    return Promise.resolve("confirmed");
  }
}

describe("supervisor fencing", () => {
  it("does not kill active work from a mismatched executor", async () => {
    const root = await mkdtemp(join(tmpdir(), "rostra-fence-"));
    roots.push(root);
    const databasePath = join(root, "rostra.sqlite");
    const db = await openStorage(databasePath);
    const config = configSchema.parse({
      version: 2,
      adapters: {},
      model_registry: { models: [] },
      defaults: { protocol: "quick" },
      protocols: {},
      similarity: { provider: "local_minilm" },
      execution: { allow_host_tools: false },
      jobs: {},
      storage: {},
      decision_graph: {},
    });
    const store = new JobStore(db, { dedupeSuccessMs: 1_000, leaseMs: 10_000 });
    store.submit(startDeliberationInputSchema.parse({
      question: "active old work",
      working_directory: root,
      protocol: "quick",
      committee: { mode: "explicit" },
      participants: [
        { participant_id: "a", cli: "fake", model: "a" },
        { participant_id: "b", cli: "fake", model: "b" },
      ],
    }));
    const claimed = store.claimNext("old-build", "old-config");
    if (claimed === undefined) throw new Error("Expected claim");
    store.handshakeWorker(claimed.job_id, claimed.dispatch_token, claimed.row_version);
    db.prepare(`
      INSERT INTO supervisor_state(
        singleton, owner_token, pid, pid_started_at_ms, build_id, config_digest,
        status, heartbeat_at_ms, updated_at_ms
      ) VALUES (1, 'old-owner', 123, 100, 'old-build', 'old-config', 'ready', 100, 100)
    `).run();
    const identity = new FixedIdentityProvider();
    await expect(ensureSupervisor({
      db,
      databasePath,
      configPath: join(root, "config.yaml"),
      config,
      buildId: "new-build",
      configDigest: "new-config",
      identityProvider: identity,
    })).rejects.toMatchObject({ code: "executor_version_mismatch" });
    expect(identity.terminated).toBe(false);
    store.close();
  });
});
