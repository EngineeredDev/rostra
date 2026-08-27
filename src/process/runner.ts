import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AppError } from "../errors.js";
import {
  SystemProcessIdentityProvider,
  requireProcessIdentity,
  type CleanupStatus,
  type ProcessIdentity,
  type ProcessIdentityProvider,
} from "./identity.js";

export interface ProcessRegistration {
  register(identity: ProcessIdentity, input: ProcessRunInput): Promise<void> | void;
}

export interface ProcessRunInput {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  terminationGraceMs: number;
  signal?: AbortSignal;
}

export interface ProcessRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  cleanupStatus: CleanupStatus;
  identity: ProcessIdentity;
}

interface ProcessRunnerOptions {
  identityProvider?: ProcessIdentityProvider;
  registrar?: ProcessRegistration;
}

class BoundedOutput {
  readonly #maximumBytes: number;
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  truncated = false;

  constructor(maximumBytes: number) {
    this.#maximumBytes = maximumBytes;
  }

  append(chunk: Buffer): void {
    const remaining = this.#maximumBytes - this.#bytes;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    if (chunk.byteLength > remaining) {
      this.#chunks.push(Buffer.from(chunk.subarray(0, remaining)));
      this.#bytes += remaining;
      this.truncated = true;
      return;
    }
    this.#chunks.push(chunk);
    this.#bytes += chunk.byteLength;
  }

  text(): string {
    return Buffer.concat(this.#chunks, this.#bytes).toString("utf8");
  }
}

export class ProcessRunner {
  readonly #identityProvider: ProcessIdentityProvider;
  readonly #registrar?: ProcessRegistration;

  constructor(options: ProcessRunnerOptions = {}) {
    this.#identityProvider = options.identityProvider ?? new SystemProcessIdentityProvider();
    if (options.registrar !== undefined) {
      this.#registrar = options.registrar;
    }
  }

  async run(input: ProcessRunInput): Promise<ProcessRunResult> {
    if (input.signal?.aborted === true) {
      throw new AppError("process_cancelled", "Process invocation was cancelled before launch");
    }
    const gatePath = fileURLToPath(new URL("./gate.mjs", import.meta.url));
    const child = spawn(process.execPath, [gatePath], {
      detached: true,
      env: {},
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (child.pid === undefined || child.stdin === null || child.stdout === null || child.stderr === null) {
      child.kill("SIGKILL");
      throw new AppError("process_start_failed", "Process gate did not expose required streams");
    }

    const stdout = new BoundedOutput(input.maxStdoutBytes);
    const stderr = new BoundedOutput(input.maxStderrBytes);
    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
    let closed = false;
    const closedPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => {
          closed = true;
          resolve({ code, signal });
        });
      },
    );

    const processGroupId = process.platform === "win32" ? undefined : child.pid;
    let identity: ProcessIdentity;
    try {
      identity = await requireProcessIdentity(this.#identityProvider, child.pid, processGroupId);
      await this.#registrar?.register(identity, input);
    } catch (error) {
      child.kill("SIGKILL");
      await closedPromise.catch(() => undefined);
      throw error;
    }

    child.stdin.end(`${JSON.stringify({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      env: input.env,
    })}\n`);

    let timedOut = false;
    let cancelled = false;
    let cleanupStatus: CleanupStatus = "confirmed";
    let terminationPromise: Promise<void> | undefined;
    const terminate = (reason: "timeout" | "cancel"): void => {
      if (terminationPromise !== undefined || closed) {
        return;
      }
      timedOut = reason === "timeout";
      cancelled = reason === "cancel";
      terminationPromise = (async () => {
        const graceful = await this.#identityProvider.terminate(identity, "SIGTERM");
        if (graceful === "uncertain") {
          cleanupStatus = "uncertain";
          return;
        }
        await Promise.race([
          closedPromise.then(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, input.terminationGraceMs)),
        ]);
        if (!closed) {
          const forced = await this.#identityProvider.terminate(identity, "SIGKILL");
          if (forced === "uncertain") {
            cleanupStatus = "uncertain";
          }
        }
      })();
    };

    const timeout = setTimeout(() => terminate("timeout"), input.timeoutMs);
    const abort = (): void => terminate("cancel");
    input.signal?.addEventListener("abort", abort, { once: true });
    let completion: { code: number | null; signal: NodeJS.Signals | null };
    try {
      completion = await closedPromise;
      await terminationPromise;
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
    }

    return {
      exitCode: completion.code,
      signal: completion.signal,
      stdout: stdout.text(),
      stderr: stderr.text(),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      timedOut,
      cancelled,
      cleanupStatus,
      identity,
    };
  }
}
