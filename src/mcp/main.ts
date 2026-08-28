import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { errorMessage } from "../errors.js";
import { createRuntime } from "./runtime.js";
import { createMcpServer } from "./server.js";

export async function runMcpServer(): Promise<StdioServerHandle> {
  const { runtime, store } = await createRuntime();
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
