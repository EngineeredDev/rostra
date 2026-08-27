import type { JobStatus } from "../contracts/tools.js";
import { AppError } from "../errors.js";

const allowedTransitions: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["dispatching", "cancelling", "cancelled"],
  dispatching: ["queued", "running", "recovery_required", "cancelling", "failed"],
  running: ["succeeded", "failed", "recovery_required", "cancelling"],
  recovery_required: ["queued", "cancelling", "cancelled"],
  cancelling: ["cancelled", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

const terminalStatus: Partial<Record<JobStatus, true>> = {
  succeeded: true,
  failed: true,
  cancelled: true,
};

export function isTerminalStatus(status: JobStatus): boolean {
  return terminalStatus[status] === true;
}

export function assertTransition(current: JobStatus, next: JobStatus): void {
  if (!allowedTransitions[current].includes(next)) {
    throw new AppError("invalid_transition", `Cannot transition job from ${current} to ${next}`);
  }
}
