import { createServer } from "node:http";
import { toNodeHandler, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
  type McpHandlerRequestOptions,
} from "@modelcontextprotocol/server";
import { errorMessage } from "../errors.js";
import { JobEventWatcher } from "../jobs/event-watcher.js";
import { deliberationUris } from "./projection.js";
import { createRuntime } from "./runtime.js";
import { createMcpServer } from "./server.js";

const MCP_PATH = "/mcp";
const PROTOCOL_ERROR_CODE = -32_000;

export interface HttpServerOptions {
  host?: string;
  port?: number;
}

export interface HttpServerHandle {
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

function protocolError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: PROTOCOL_ERROR_CODE, message }, id: null }),
    { status, headers: { "content-type": "application/json" } },
  );
}

/**
 * Serves the MCP tool surface over Streamable HTTP on loopback. The endpoint is unauthenticated:
 * DNS-rebinding protection is a localhost `Host`/`Origin` check, nothing more.
 */
export async function runHttpServer(options: HttpServerOptions = {}): Promise<HttpServerHandle> {
  const { runtime, store, config } = await createRuntime();
  const host = options.host ?? config.http.host;
  const port = options.port ?? config.http.port;
  const reportError = (error: unknown): void => {
    process.stderr.write(`${errorMessage(error)}\n`);
  };
  const allowedHostnames = localhostAllowedHostnames();
  const allowedOrigins = localhostAllowedOrigins();
  if (!allowedHostnames.includes(host)) {
    process.stderr.write(
      `rostra: ${host} is not a loopback address; this MCP endpoint is unauthenticated\n`,
    );
  }

  // Sessions were removed from Streamable HTTP in 2026-07-28 and no event store is configured,
  // so an inbound Mcp-Session-Id or Last-Event-ID is neither honored nor echoed.
  const handler = createMcpHandler(() => createMcpServer(runtime), {
    responseMode: "auto",
    legacy: "stateless",
    maxSubscriptions: config.http.max_subscriptions,
    keepAliveMs: config.http.keep_alive_ms,
    onerror: reportError,
  });

  const fetchHandler = async (
    request: Request,
    requestOptions?: McpHandlerRequestOptions,
  ): Promise<Response> => {
    const rejected =
      hostHeaderValidationResponse(request, allowedHostnames) ??
      originValidationResponse(request, allowedOrigins);
    if (rejected !== undefined) {
      return rejected;
    }
    const path = new URL(request.url).pathname;
    if (path !== MCP_PATH) {
      return protocolError(404, `Unknown path: ${path}`);
    }
    if (request.method !== "POST") {
      return protocolError(405, "Method not allowed.");
    }
    return handler.fetch(request, requestOptions);
  };

  // createMcpHandler builds a fresh McpServer per request, so there is no long-lived instance to
  // push on: updates go through the handler's event bus, which the listen router filters.
  const watcher = new JobEventWatcher({
    store,
    notifier: { resourceUpdated: (uri) => handler.notify.resourceUpdated(uri) },
    intervalMs: config.jobs.poll_interval_ms,
    urisForJob: deliberationUris,
    onerror: reportError,
  });
  watcher.start();

  const nodeHandler = toNodeHandler({ fetch: fetchHandler }, { onerror: reportError });
  const server = createServer((request, response) => {
    // The adapter declares `method` optional; Node types it `string | undefined`, which
    // exactOptionalPropertyTypes treats as a different type.
    void nodeHandler(request as NodeIncomingMessageLike, response).catch(reportError);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  const handle: HttpServerHandle = {
    host,
    port: boundPort,
    url: `http://${host.includes(":") ? `[${host}]` : host}:${boundPort}${MCP_PATH}`,
    close: async (): Promise<void> => {
      watcher.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await handler.close();
      store.close();
    },
  };
  const close = (): void => {
    void handle.close().catch(reportError);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return handle;
}
