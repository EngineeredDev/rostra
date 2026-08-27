import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { constants } from "node:fs";
import { AppError } from "../errors.js";

interface PathOptions {
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
}

interface ConfigPathOptions extends PathOptions {
  packageRoot?: string;
}

async function readable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}


export async function resolveConfigPath(options: ConfigPathOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const packageRoot =
    options.packageRoot ?? dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const explicit = env.AI_COUNSEL_CONFIG;
  if (explicit !== undefined && explicit.trim() !== "") {
    const path = resolve(explicit);
    if (!(await readable(path))) {
      throw new AppError("config_not_found", `Configured file is not readable: ${path}`);
    }
    return path;
  }

  const candidates = [
    env.XDG_CONFIG_HOME === undefined
      ? undefined
      : join(resolve(env.XDG_CONFIG_HOME), "ai-counsel", "config.yaml"),
    join(resolve(home), ".config", "ai-counsel", "config.yaml"),
    join(resolve(packageRoot), "config.example.yaml"),
  ].filter((value): value is string => value !== undefined);

  for (const candidate of candidates) {
    if (await readable(candidate)) {
      return candidate;
    }
  }
  throw new AppError("config_not_found", "No readable AI Counsel configuration was found");
}

export function resolveDataHome(options: PathOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  if (env.AI_COUNSEL_DATA_HOME !== undefined && env.AI_COUNSEL_DATA_HOME.trim() !== "") {
    return resolve(env.AI_COUNSEL_DATA_HOME);
  }
  if (env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME.trim() !== "") {
    return join(resolve(env.XDG_DATA_HOME), "ai-counsel");
  }
  return join(resolve(home), ".local", "share", "ai-counsel");
}
