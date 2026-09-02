import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppError } from "../errors.js";

const execFileAsync = promisify(execFile);

export interface ProcessIdentity {
  pid: number;
  startedAtMs: number;
  processGroupId?: number;
}

export type CleanupStatus = "confirmed" | "uncertain";

export interface ProcessIdentityProvider {
  identify(pid: number, processGroupId?: number): Promise<ProcessIdentity | undefined>;
  terminate(identity: ProcessIdentity, signal: NodeJS.Signals): Promise<CleanupStatus>;
}

async function queryStartedAt(pid: number): Promise<number | undefined> {
  try {
    if (process.platform === "win32") {
      const script = [
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
        "if ($null -ne $p) { $p.CreationDate.ToUniversalTime().ToString('o') }",
      ].join("; ");
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", windowsHide: true },
      );
      const timestamp = Date.parse(stdout.trim());
      return Number.isFinite(timestamp) ? timestamp : undefined;
    }
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
    });
    const timestamp = Date.parse(stdout.trim());
    return Number.isFinite(timestamp) ? timestamp : undefined;
  } catch {
    return undefined;
  }
}

export class SystemProcessIdentityProvider implements ProcessIdentityProvider {
  async identify(pid: number, processGroupId?: number): Promise<ProcessIdentity | undefined> {
    const startedAtMs = await queryStartedAt(pid);
    if (startedAtMs === undefined) {
      return undefined;
    }
    return {
      pid,
      startedAtMs,
      ...(processGroupId === undefined ? {} : { processGroupId }),
    };
  }

  async terminate(identity: ProcessIdentity, signal: NodeJS.Signals): Promise<CleanupStatus> {
    const current = await this.identify(identity.pid, identity.processGroupId);
    if (current === undefined || Math.abs(current.startedAtMs - identity.startedAtMs) > 1_500) {
      return "uncertain";
    }
    try {
      if (process.platform === "win32") {
        await execFileAsync("taskkill.exe", ["/PID", String(identity.pid), "/T", "/F"], {
          windowsHide: true,
        });
      } else {
        process.kill(-(identity.processGroupId ?? identity.pid), signal);
      }
      return "confirmed";
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") {
        return "confirmed";
      }
      return "uncertain";
    }
  }
}

export async function requireProcessIdentity(
  provider: ProcessIdentityProvider,
  pid: number,
  processGroupId?: number,
): Promise<ProcessIdentity> {
  const identity = await provider.identify(pid, processGroupId);
  if (identity === undefined) {
    throw new AppError("process_identity_unavailable", `Cannot verify process ${pid}`);
  }
  return identity;
}

export function currentProcessIdentity(): ProcessIdentity {
  return {
    pid: process.pid,
    startedAtMs: Date.now() - Math.round(process.uptime() * 1_000),
    ...(process.platform === "win32" ? {} : { processGroupId: process.pid }),
  };
}
