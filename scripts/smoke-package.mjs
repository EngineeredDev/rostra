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
if (
  readmeVersions.length === 0 ||
  readmeVersions.some((version) => version !== packageValue.version)
) {
  throw new Error("README.md package versions do not match package.json");
}
const npmPackage = serverValue.packages.find((value) => value.registryType === "npm");
if (
  packageValue.mcpName !== serverValue.name ||
  packageValue.version !== serverValue.version ||
  packageValue.name !== npmPackage?.identifier ||
  packageValue.version !== npmPackage.version ||
  packageValue.bin?.rostra !== "dist/cli/main.js"
) {
  throw new Error("package.json and server.json release metadata do not match");
}
const root = await mkdtemp(join(tmpdir(), "rostra-package-"));

function runPackageManager(command, args) {
  if (process.platform === "win32") {
    execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command, ...args], {
      stdio: "inherit",
    });
    return;
  }
  execFileSync(command, args, { stdio: "inherit" });
}

try {
  runPackageManager("pnpm", ["pack", "--pack-destination", root]);
  const archives = (await readdir(root)).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1)
    throw new Error(`Expected one package archive, found ${archives.length}`);
  const archive = join(root, archives[0]);
  const installRoot = join(root, "install");
  runPackageManager("npm", ["install", "--prefix", installRoot, archive]);

  const configPath = join(root, "config.yaml");
  const dataHome = join(root, "data");
  await mkdir(dataHome, { recursive: true });
  await writeFile(
    configPath,
    `
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
  agreement_threshold: 0.82
  retrieval_threshold: 0.72
  thresholds_revision: smoke-v1
execution: { allow_host_tools: false }
jobs: {}
storage: {}
decision_graph: {}
`,
  );

  const cliShim = join(installRoot, "node_modules", ".bin", "rostra");
  const cliEntrypoint = join(
    installRoot,
    "node_modules",
    ...packageValue.name.split("/"),
    packageValue.bin.rostra,
  );
  const cliCommand = process.platform === "win32" ? process.execPath : cliShim;
  const cliPrefix = process.platform === "win32" ? [cliEntrypoint] : [];
  const env = {
    ...process.env,
    ROSTRA_CONFIG: configPath,
    ROSTRA_DATA_HOME: dataHome,
  };
  const runCli = (args) =>
    execFileSync(cliCommand, [...cliPrefix, ...args], {
      encoding: "utf8",
      env,
    });
  const initOutput = runCli(["init"]);
  if (!initOutput.includes(`Kept existing configuration: ${configPath}`)) {
    throw new Error(`Unexpected init output: ${initOutput}`);
  }

  const jobsOutput = runCli(["jobs", "list"]);
  const jobs = JSON.parse(jobsOutput);
  if (!Array.isArray(jobs.jobs) || jobs.jobs.length !== 0) {
    throw new Error(`Unexpected jobs output: ${jobsOutput}`);
  }

  process.stdout.write("Packed package installed and initialized successfully.\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
