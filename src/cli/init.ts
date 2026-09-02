import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig } from "../config/loader.js";
import {
  resolveDataHome,
  resolvePackagedConfigPath,
  resolveUserConfigPath,
} from "../config/paths.js";
import { fetchPinnedMiniLm } from "../similarity/fetch-model.js";

interface InitializeOptions {
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
  packageRoot?: string;
  fetchModel?: (dataHome: string) => Promise<string>;
}

export interface InitializeResult {
  configPath: string;
  configCreated: boolean;
  dataHome: string;
  modelDirectory?: string;
}

export async function initialize(options: InitializeOptions = {}): Promise<InitializeResult> {
  const pathOptions = {
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
  };
  const configPath = resolveUserConfigPath(pathOptions);
  await mkdir(dirname(configPath), { recursive: true });

  let configCreated = false;
  try {
    await copyFile(
      resolvePackagedConfigPath({
        ...pathOptions,
        ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
      }),
      configPath,
      constants.COPYFILE_EXCL,
    );
    configCreated = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }

  const dataHome = resolveDataHome(pathOptions);
  await mkdir(dataHome, { recursive: true });
  const config = await loadConfig(configPath);
  if (config.similarity.provider !== "local_minilm") {
    return { configPath, configCreated, dataHome };
  }

  const modelDirectory = await (options.fetchModel ?? fetchPinnedMiniLm)(dataHome);
  return { configPath, configCreated, dataHome, modelDirectory };
}
