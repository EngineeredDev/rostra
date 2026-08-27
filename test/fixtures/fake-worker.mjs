#!/usr/bin/env node
import process from "node:process";
import { loadConfig } from "../../dist/config/loader.js";
import { parseWorkerArguments } from "../../dist/jobs/worker-main.js";
import { runWorker } from "../../dist/jobs/worker.js";

const arguments_ = parseWorkerArguments(process.argv.slice(2));
const config = await loadConfig(arguments_.config);
const runner = {
  async execute(job, context) {
    if (job.question.includes("cancel")) {
      await new Promise((resolve) => {
        context.signal.addEventListener("abort", resolve, { once: true });
      });
    }
    return {
      status: "partial",
      result: {
        status: "partial",
        fake: true,
        question: job.question,
        execution_isolation: "builtin_confined",
      },
    };
  },
};

await runWorker({
  databasePath: arguments_.database,
  config,
  jobId: arguments_.jobId,
  dispatchToken: arguments_.dispatchToken,
  expectedVersion: arguments_.expectedVersion,
  runner,
});
