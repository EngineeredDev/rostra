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

export function resolveUserConfigPath(options: PathOptions = {}): string {
  const env = options.env ?? process.env;
  const explicit = env.AI_COUNSEL_CONFIG;
  if (explicit !== undefined && explicit.trim() !== "") {
    return resolve(explicit);
  }
  return env.XDG_CONFIG_HOME === undefined
    ? join(resolve(options.homeDir ?? homedir()), ".config", "ai-counsel", "config.yaml")
    : join(resolve(env.XDG_CONFIG_HOME), "ai-counsel", "config.yaml");
}

export function resolvePackagedConfigPath(options: ConfigPathOptions = {}): string {
  const packageRoot =
    options.packageRoot ?? dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  return join(resolve(packageRoot), "config.example.yaml");
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
  const homeConfig = join(resolve(home), ".config", "ai-counsel", "config.yaml");
  const explicit = env.AI_COUNSEL_CONFIG;
  if (explicit !== undefined && explicit.trim() !== "") {
    const path = resolve(explicit);
    if (!(await readable(path))) {
      throw new AppError("config_not_found", `Configured file is not readable: ${path}`);
    }
    return path;
  }

  const userConfig = resolveUserConfigPath(options);
  const candidates = userConfig === homeConfig
    ? [homeConfig, resolvePackagedConfigPath(options)]
    : [userConfig, homeConfig, resolvePackagedConfigPath(options)];

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
