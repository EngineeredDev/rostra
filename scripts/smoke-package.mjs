import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const packageValue = JSON.parse(await readFile("package.json", "utf8"));
const serverValue = JSON.parse(await readFile("server.json", "utf8"));
const npmPackage = serverValue.packages.find((value) => value.registryType === "npm");
if (
  packageValue.mcpName !== serverValue.name ||
  packageValue.version !== serverValue.version ||
  packageValue.name !== npmPackage?.identifier ||
  packageValue.version !== npmPackage.version
) {
  throw new Error("package.json and server.json release metadata do not match");
}
const root = await mkdtemp(join(tmpdir(), "ai-counsel-package-"));

try {
  execFileSync("pnpm", ["pack", "--pack-destination", root], { stdio: "inherit" });
  const archive = join(root, `ai-counsel-${packageValue.version}.tgz`);
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

  const entrypoint = join(installRoot, "node_modules", "ai-counsel", "dist", "cli", "main.js");
  const env = {
    ...process.env,
    AI_COUNSEL_CONFIG: configPath,
    AI_COUNSEL_DATA_HOME: dataHome,
  };
  const initOutput = execFileSync(process.execPath, [entrypoint, "init"], {
    encoding: "utf8",
    env,
  });
  if (!initOutput.includes(`Kept existing configuration: ${configPath}`)) {
    throw new Error(`Unexpected init output: ${initOutput}`);
  }

  const jobsOutput = execFileSync(process.execPath, [entrypoint, "jobs", "list"], {
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
