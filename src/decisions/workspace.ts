import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { AppError } from "../errors.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceIdentity {
  id: string;
  canonicalRoot: string;
}

export async function deriveWorkspaceIdentity(
  workingDirectory: string,
): Promise<WorkspaceIdentity> {
  let canonicalDirectory: string;
  try {
    canonicalDirectory = await realpath(workingDirectory);
    if (!(await stat(canonicalDirectory)).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new AppError(
      "workspace_unavailable",
      `Working directory is not accessible: ${workingDirectory}`,
    );
  }

  let canonicalRoot: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: canonicalDirectory, encoding: "utf8", windowsHide: true },
    );
    canonicalRoot = await realpath(stdout.trim());
  } catch {
    canonicalRoot = canonicalDirectory;
  }
  return {
    id: createHash("sha256").update(`local\0${canonicalRoot}`).digest("hex"),
    canonicalRoot,
  };
}
