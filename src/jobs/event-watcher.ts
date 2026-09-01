import type { JobStatus } from "../contracts/tools.js";
import type { JobStore } from "./store.js";

const ACTIVE_STATUSES: readonly JobStatus[] = [
  "queued",
  "dispatching",
  "running",
  "recovery_required",
  "cancelling",
];
const JOB_PAGE = 100;
const EVENT_BATCH = 500;

export interface RostraNotifier {
  resourceUpdated(uri: string): void;
}

export interface JobEventWatcherOptions {
  store: JobStore;
  notifier: RostraNotifier;
  intervalMs: number;
  urisForJob: (jobId: string) => readonly string[];
  onerror?: (error: unknown) => void;
}

/**
 * Job transitions happen in detached supervisor and worker processes, so the server process has to
 * discover them itself. Watching every non-terminal job is cheap - that set is bounded by
 * `jobs.max_concurrency` plus queue depth - and needs no schema change: both reads are indexed.
 *
 * A job that is created and finishes inside one interval is never seen as active and publishes
 * nothing; reading the resource directly still returns the finished job.
 */
export class JobEventWatcher {
  readonly #store: JobStore;
  readonly #notifier: RostraNotifier;
  readonly #intervalMs: number;
  readonly #urisForJob: (jobId: string) => readonly string[];
  readonly #onerror: (error: unknown) => void;
  readonly #watermarks = new Map<string, number>();
  #timer: NodeJS.Timeout | undefined;

  constructor(options: JobEventWatcherOptions) {
    this.#store = options.store;
    this.#notifier = options.notifier;
    this.#intervalMs = options.intervalMs;
    this.#urisForJob = options.urisForJob;
    this.#onerror = options.onerror ?? ((): void => undefined);
  }

  start(): void {
    if (this.#timer !== undefined) {
      return;
    }
    this.#timer = setInterval(() => {
      this.tick();
    }, this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === undefined) {
      return;
    }
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  tick(): void {
    try {
      const active = new Set<string>();
      for (const jobId of this.#activeJobIds()) {
        active.add(jobId);
        this.#drain(jobId);
      }
      for (const jobId of [...this.#watermarks.keys()]) {
        if (active.has(jobId)) {
          continue;
        }
        this.#drain(jobId);
        this.#watermarks.delete(jobId);
      }
    } catch (error) {
      this.#onerror(error);
    }
  }

  #activeJobIds(): string[] {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = this.#store.list({
        statuses: ACTIVE_STATUSES,
        limit: JOB_PAGE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      ids.push(...page.jobs.map((job) => job.job_id));
      if (page.next_cursor === undefined) {
        return ids;
      }
      cursor = page.next_cursor;
    }
  }

  #drain(jobId: string): void {
    const watermark = this.#watermarks.get(jobId) ?? 0;
    let seq = watermark;
    for (;;) {
      const batch = this.#store.events(jobId, seq, EVENT_BATCH);
      const last = batch.at(-1);
      if (last === undefined) {
        break;
      }
      seq = last.seq;
      if (batch.length < EVENT_BATCH) {
        break;
      }
    }
    this.#watermarks.set(jobId, seq);
    if (seq === watermark) {
      return;
    }
    for (const uri of this.#urisForJob(jobId)) {
      this.#notifier.resourceUpdated(uri);
    }
  }
}
