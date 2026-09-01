import type { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { errorMessage } from "../errors.js";
import { JobEventWatcher, type RostraNotifier } from "../jobs/event-watcher.js";
import { deliberationUris } from "./projection.js";
import { createRuntime } from "./runtime.js";
import { createMcpServer } from "./server.js";

export async function runMcpServer(): Promise<StdioServerHandle> {
  const { runtime, store, config } = await createRuntime();
  const reportError = (error: unknown): void => {
    process.stderr.write(`${errorMessage(error)}\n`);
  };
  // StdioServerHandle only exposes close(), so capture the instance the factory produced: its
  // outbound intercept is what filters and stamps updates onto each open subscription.
  let pinned: McpServer | undefined;
  const handle = serveStdio(() => (pinned = createMcpServer(runtime)), { onerror: reportError });
  const notifier: RostraNotifier = {
    resourceUpdated: (uri) => {
      void pinned?.server.sendResourceUpdated({ uri }).catch(reportError);
    },
  };
  const watcher = new JobEventWatcher({
    store,
    notifier,
    intervalMs: config.jobs.poll_interval_ms,
    urisForJob: deliberationUris,
    onerror: reportError,
  });
  watcher.start();
  const close = (): void => {
    watcher.stop();
    void handle.close().finally(() => store.close());
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return handle;
}
