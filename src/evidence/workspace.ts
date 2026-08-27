import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { AppError, errorMessage } from "../errors.js";
import { ProcessRunner, type ProcessRunInput, type ProcessRunResult } from "../process/runner.js";
export { evidenceOperationNames } from "./operations.js";


interface ProcessRunnerPort {
  run(input: ProcessRunInput): Promise<ProcessRunResult>;
}

interface EvidenceWorkspaceOptions {
  ignoredPaths?: readonly string[];
  maxBytes?: number;
  maxResults?: number;
  timeoutMs?: number;
  beforeOpen?: (path: string) => Promise<void>;
  processRunner?: ProcessRunnerPort;
}

export interface FileEvidence {
  relativePath: string;
  text: string;
  contentHash: string;
  bytes: number;
  executionIsolation: "builtin_confined";
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

interface ResolvedEvidencePath {
  absolutePath: string;
  relativePath: string;
  device: bigint;
  inode: bigint;
  size: bigint;
  modifiedMs: number;
}

function portableRelative(path: string): string {
  return path.split(sep).join("/");
}

export class EvidenceWorkspace {
  readonly root: string;
  readonly #ignoredPaths: readonly string[];
  readonly #maxBytes: number;
  readonly #maxResults: number;
  readonly #timeoutMs: number;
  readonly #beforeOpen?: (path: string) => Promise<void>;
  readonly #runner: ProcessRunnerPort;

  private constructor(root: string, options: EvidenceWorkspaceOptions) {
    this.root = root;
    this.#ignoredPaths = (options.ignoredPaths ?? [".git", "node_modules", "dist"])
      .map((path) => portableRelative(path).replace(/^\.\//, "").replace(/\/$/, ""));
    this.#maxBytes = options.maxBytes ?? 1_048_576;
    this.#maxResults = options.maxResults ?? 100;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    if (options.beforeOpen !== undefined) {
      this.#beforeOpen = options.beforeOpen;
    }
    this.#runner = options.processRunner ?? new ProcessRunner();
  }

  static async create(
    workingDirectory: string,
    options: EvidenceWorkspaceOptions = {},
  ): Promise<EvidenceWorkspace> {
    let root: string;
    try {
      root = await realpath(workingDirectory);
      if (!(await stat(root)).isDirectory()) {
        throw new AppError("workspace_not_directory", `${workingDirectory} is not a directory`);
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError("workspace_unavailable", errorMessage(error));
    }
    return new EvidenceWorkspace(root, options);
  }

  #inside(path: string): boolean {
    return path === this.root || path.startsWith(`${this.root}${sep}`);
  }

  #ignored(relativePath: string): boolean {
    const portable = portableRelative(relativePath);
    const segments = portable.split("/");
    return this.#ignoredPaths.some(
      (ignored) =>
        portable === ignored ||
        portable.startsWith(`${ignored}/`) ||
        (!ignored.includes("/") && segments.includes(ignored)),
    );
  }

  async #resolvePath(input: string): Promise<ResolvedEvidencePath> {
    if (input.trim() === "" || isAbsolute(input)) {
      throw new AppError("evidence_path_escape", `Path must be relative to ${this.root}`);
    }
    const lexical = resolve(this.root, input);
    if (!this.#inside(lexical)) {
      throw new AppError("evidence_path_escape", `Path escapes workspace: ${input}`);
    }
    let canonical: string;
    try {
      canonical = await realpath(lexical);
    } catch (error) {
      throw new AppError("evidence_not_found", errorMessage(error));
    }
    if (!this.#inside(canonical)) {
      throw new AppError("evidence_path_escape", `Symlink escapes workspace: ${input}`);
    }
    const relativePath = portableRelative(relative(this.root, canonical));
    if (this.#ignored(relativePath)) {
      throw new AppError("evidence_path_ignored", `Path is excluded: ${relativePath}`);
    }
    const metadata = await stat(canonical, { bigint: true });
    if (!metadata.isFile()) {
      throw new AppError("evidence_not_file", `${relativePath} is not a file`);
    }
    return {
      absolutePath: canonical,
      relativePath,
      device: metadata.dev,
      inode: metadata.ino,
      size: metadata.size,
      modifiedMs: Number(metadata.mtimeMs),
    };
  }

  async readFile(path: string): Promise<FileEvidence> {
    const resolvedPath = await this.#resolvePath(path);
    await this.#beforeOpen?.(resolvedPath.absolutePath);
    let handle;
    try {
      handle = await open(resolvedPath.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      throw new AppError("evidence_path_changed", errorMessage(error));
    }
    try {
      const opened = await handle.stat({ bigint: true });
      let currentCanonical: string;
      try {
        currentCanonical = await realpath(resolvedPath.absolutePath);
      } catch (error) {
        throw new AppError("evidence_path_changed", errorMessage(error));
      }
      if (
        !this.#inside(currentCanonical) ||
        opened.dev !== resolvedPath.device ||
        opened.ino !== resolvedPath.inode ||
        opened.size !== resolvedPath.size ||
        Number(opened.mtimeMs) !== resolvedPath.modifiedMs
      ) {
        throw new AppError("evidence_path_changed", `Path changed before read: ${path}`);
      }
      if (opened.size > BigInt(this.#maxBytes)) {
        throw new AppError("evidence_too_large", `${path} exceeds ${this.#maxBytes} bytes`);
      }
      const buffer = Buffer.alloc(Number(opened.size) + 1);
      const read = await handle.read(buffer, 0, buffer.byteLength, 0);
      if (read.bytesRead > this.#maxBytes) {
        throw new AppError("evidence_too_large", `${path} exceeds ${this.#maxBytes} bytes`);
      }
      const after = await handle.stat({ bigint: true });
      if (
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== opened.size ||
        Number(after.mtimeMs) !== Number(opened.mtimeMs)
      ) {
        throw new AppError("evidence_path_changed", `File changed during read: ${path}`);
      }
      const content = buffer.subarray(0, read.bytesRead);
      if (content.includes(0)) {
        throw new AppError("binary_file", `${path} is binary`);
      }
      return {
        relativePath: resolvedPath.relativePath,
        text: content.toString("utf8"),
        contentHash: createHash("sha256").update(content).digest("hex"),
        bytes: content.byteLength,
        executionIsolation: "builtin_confined",
      };
    } finally {
      await handle.close();
    }
  }

  async #walk(): Promise<string[]> {
    const files: string[] = [];
    const directories = [this.root];
    const deadline = Date.now() + this.#timeoutMs;
    while (directories.length > 0) {
      if (Date.now() > deadline) {
        throw new AppError("evidence_timeout", "File traversal exceeded its time limit");
      }
      const directory = directories.pop();
      if (directory === undefined) {
        break;
      }
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const path = resolve(directory, entry.name);
        const relativePath = portableRelative(relative(this.root, path));
        if (this.#ignored(relativePath) || entry.isSymbolicLink()) {
          continue;
        }
        const metadata = await lstat(path);
        if (metadata.isDirectory()) {
          const canonical = await realpath(path);
          if (!this.#inside(canonical)) {
            throw new AppError("evidence_path_escape", `Directory escapes workspace: ${relativePath}`);
          }
          directories.push(path);
        } else if (metadata.isFile()) {
          files.push(relativePath);
          if (files.length > this.#maxResults * 100) {
            throw new AppError("evidence_result_limit", "File traversal exceeded its result limit");
          }
        }
      }
    }
    return files.sort();
  }

  async listFiles(): Promise<string[]> {
    return (await this.#walk()).slice(0, this.#maxResults);
  }

  async getFileTree(): Promise<{ root: string; files: string[] }> {
    return { root: this.root, files: await this.listFiles() };
  }

  async searchFiles(query: string): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
    if (query === "") {
      throw new AppError("invalid_search_query", "Search query must not be empty");
    }
    const matches: SearchMatch[] = [];
    for (const path of await this.#walk()) {
      let evidence: FileEvidence;
      try {
        evidence = await this.readFile(path);
      } catch (error) {
        if (error instanceof AppError && (error.code === "binary_file" || error.code === "evidence_too_large")) {
          continue;
        }
        throw error;
      }
      for (const [index, line] of evidence.text.split("\n").entries()) {
        if (line.includes(query)) {
          matches.push({ path, line: index + 1, text: line });
          if (matches.length === this.#maxResults) {
            return { matches, truncated: true };
          }
        }
      }
    }
    return { matches, truncated: false };
  }

  async gitStatus(): Promise<string> {
    return this.#runGit(["status", "--short", "--untracked-files=all"]);
  }

  async gitDiff(): Promise<string> {
    return this.#runGit(["diff", "--no-ext-diff", "--"]);
  }

  async #runGit(args: readonly string[]): Promise<string> {
    const environment: Record<string, string> = {};
    for (const name of ["PATH", "HOME", "SystemRoot"] as const) {
      const value = process.env[name];
      if (value !== undefined) {
        environment[name] = value;
      }
    }
    const result = await this.#runner.run({
      command: "git",
      args,
      cwd: this.root,
      env: environment,
      timeoutMs: this.#timeoutMs,
      maxStdoutBytes: this.#maxBytes,
      maxStderrBytes: Math.min(this.#maxBytes, 262_144),
      terminationGraceMs: 1_000,
    });
    if (result.exitCode !== 0) {
      throw new AppError("git_evidence_failed", `git exited with ${String(result.exitCode)}`);
    }
    return result.stdout;
  }
}
