import { AppError, errorMessage } from "../errors.js";

export type ChildCleanup = () => Promise<void> | void;

export class RunContext {
  readonly jobId: string;
  readonly abortController = new AbortController();
  readonly #children = new Set<ChildCleanup>();
  #cleanupStatus: "confirmed" | "uncertain" = "confirmed";

  constructor(jobId: string) {
    this.jobId = jobId;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get cleanupStatus(): "confirmed" | "uncertain" {
    return this.#cleanupStatus;
  }

  registerChild(cleanup: ChildCleanup): () => void {
    this.#children.add(cleanup);
    return () => this.#children.delete(cleanup);
  }

  cancel(reason: string): void {
    if (!this.signal.aborted) {
      this.abortController.abort(new AppError("job_cancelled", reason));
    }
  }

  async cleanup(): Promise<void> {
    const children = [...this.#children];
    this.#children.clear();
    const results = await Promise.allSettled(children.map(async (cleanup) => cleanup()));
    if (results.some((result) => result.status === "rejected")) {
      this.#cleanupStatus = "uncertain";
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => errorMessage(result.reason));
      throw new AppError("cleanup_uncertain", failures.join("; "));
    }
  }
}
