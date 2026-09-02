import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const packageValue = JSON.parse(await readFile("package.json", "utf8"));
const serverValue = JSON.parse(await readFile("server.json", "utf8"));
const readmeValue = await readFile("README.md", "utf8");
const readmeVersions = [
  ...readmeValue.matchAll(
    /@engineereddev\/rostra@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/g,
  ),
].map((match) => match[1]);
if (readmeVersions.length === 0 || readmeVersions.some((version) => version !== packageValue.version)) {
  throw new Error("README.md package versions do not match package.json");
}
const npmPackage = serverValue.packages.find((value) => value.registryType === "npm");
if (
  packageValue.mcpName !== serverValue.name ||
  packageValue.version !== serverValue.version ||
  packageValue.name !== npmPackage?.identifier ||
  packageValue.version !== npmPackage.version
) {
  throw new Error("package.json and server.json release metadata do not match");
}
const root = await mkdtemp(join(tmpdir(), "rostra-package-"));

try {
  execFileSync("pnpm", ["pack", "--pack-destination", root], { stdio: "inherit" });
  const archives = (await readdir(root)).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) throw new Error(`Expected one package archive, found ${archives.length}`);
  const archive = join(root, archives[0]);
  const installRoot = join(root, "install");
  execFileSync("npm", ["install", "--prefix", installRoot, archive], { stdio: "inherit" });

  const configPath = join(root, "config.yaml");
  const dataHome = join(root, "data");
  await mkdir(dataHome, { recursive: true });
  await writeFile(configPath, `
version: 2
adapters: {}
model_registry: { models: [] }
defaults: { protocol: quick }
protocols: {}
similarity:
  provider: openai_compatible
  base_url: http://127.0.0.1:9999
  model: test
  api_key_env: TEST_API_KEY
execution: { allow_host_tools: false }
jobs: {}
storage: {}
decision_graph: {}
`);

  const cli = join(
    installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "rostra.cmd" : "rostra",
  );
  const env = {
    ...process.env,
    ROSTRA_CONFIG: configPath,
    ROSTRA_DATA_HOME: dataHome,
  };
  const initOutput = execFileSync(cli, ["init"], {
    encoding: "utf8",
    env,
  });
  if (!initOutput.includes(`Kept existing configuration: ${configPath}`)) {
    throw new Error(`Unexpected init output: ${initOutput}`);
  }

  const jobsOutput = execFileSync(cli, ["jobs", "list"], {
    encoding: "utf8",
    env,
  });
  const jobs = JSON.parse(jobsOutput);
  if (!Array.isArray(jobs.jobs) || jobs.jobs.length !== 0) {
    throw new Error(`Unexpected jobs output: ${jobsOutput}`);
  }

  process.stdout.write("Packed package installed and initialized successfully.\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
