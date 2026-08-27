import { describe, expect, it } from "vitest";
import { ProcessRunner } from "../../src/process/runner.js";

class RecordingRegistrar {
  registered = false;

  register(): void {
    this.registered = true;
  }
}

describe("bounded process runner", () => {
  it("registers before releasing the external command and bounds output", async () => {
    const registrar = new RecordingRegistrar();
    const runner = new ProcessRunner({ registrar });
    const result = await runner.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(10000))"],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 5_000,
      maxStdoutBytes: 128,
      maxStderrBytes: 128,
      terminationGraceMs: 100,
    });
    expect(registrar.registered).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(128);
    expect(result.stdoutTruncated).toBe(true);
  });

  it("terminates timed-out commands", async () => {
    const runner = new ProcessRunner();
    // This integration test uses the platform clock to exercise OS timeout escalation.
    const result = await runner.run({
      command: process.execPath,
      args: [
        "-e",
        "const {spawn}=require('node:child_process');const {writeSync}=require('node:fs');const {createServer}=require('node:net');const childCode=\"const {writeSync}=require('node:fs');const {createServer}=require('node:net');createServer().listen(0);process.on('SIGTERM',()=>{writeSync(1,'CLEANED');process.exit(0)})\";const c=spawn(process.execPath,['-e',childCode],{stdio:['ignore','inherit','ignore']});writeSync(1,String(c.pid)+':');createServer().listen(0);process.on('SIGTERM',()=>c.once('exit',()=>process.exit(0)))",
      ],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 500,
      maxStdoutBytes: 128,
      maxStderrBytes: 128,
      terminationGraceMs: 1_000,
    });
    expect(result.timedOut).toBe(true);
    expect(result.cleanupStatus).toBe("confirmed");
    const [pidText, marker] = result.stdout.split(":");
    const descendantPid = Number(pidText);
    expect(Number.isInteger(descendantPid)).toBe(true);
    expect(marker).toBe("CLEANED");
  });
});
