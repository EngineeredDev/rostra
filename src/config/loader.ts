import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { validateAdapterConfigurations } from "../adapters/registry.js";
import { AppError, errorMessage } from "../errors.js";
import { configSchema, type Config } from "./schema.js";
import { resolveConfigPath } from "./paths.js";

export async function loadConfig(path?: string): Promise<Config> {
  const configPath = path ?? (await resolveConfigPath());
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    throw new AppError("config_not_found", `Cannot read configuration ${configPath}: ${errorMessage(error)}`);
  }

  let value: unknown;
  try {
    value = parse(raw);
  } catch (error) {
    throw new AppError("invalid_config", `Cannot parse configuration ${configPath}: ${errorMessage(error)}`);
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version !== 2
  ) {
    throw new AppError(
      "unsupported_config_version",
      `Configuration ${configPath} must use version 2`,
    );
  }

  const parsed = configSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(
      "invalid_config",
      `Configuration ${configPath} is invalid`,
      parsed.error.issues,
    );
  }
  validateAdapterConfigurations(parsed.data.adapters);
  return parsed.data;
}
