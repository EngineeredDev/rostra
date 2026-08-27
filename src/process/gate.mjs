import process from "node:process";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const [line] = await once(lines, "line");
lines.close();

let request;
try {
  request = JSON.parse(line);
} catch (error) {
  process.stderr.write(`Invalid process gate request: ${String(error)}\n`);
  process.exitCode = 1;
}

if (request !== undefined) {
  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: request.env,
    shell: false,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  const forward = (signal) => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
  const [code, signal] = await once(child, "exit");
  process.exitCode = typeof code === "number" ? code : signal === null ? 1 : 128;
}
