import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { deliveryControllerService, type DeliveryControllerDeps } from "./delivery-controller.js";

// The NORMAL path from publication_authorized to pr_opened. A person or
// agent calling POST /delivery-candidates/:id/publish (see
// routes/delivery-controller.ts) is the exceptional, operator-triggered
// path — for forcing an attempt right now, or retrying a publish_failed
// candidate that has exhausted (or was never eligible for) automatic retry.
// This worker is what's actually supposed to drive the pipeline under
// normal operation: on a schedule, with no human in the loop, claiming
// freshly-authorized candidates, reconciling any whose claimant crashed
// without finishing, and retrying candidates whose route contract has
// explicitly opted into bounded automatic retry of transient failures.
//
// Gated by isWorkerActivated() (see delivery_worker_activation.ts) as the
// very first thing every tick does — a tick with no active activation row
// does none of the above, every time, regardless of whether the scheduler
// itself is running. See startDeliveryControllerWorker's own comment and
// app.ts's construction site for the second, deploy-time layer of the gate.

export interface WorkerTickSummary {
  workerId: string;
  /** False if this tick did nothing because no worker activation is
   * currently active — every count below is 0 in that case. */
  activated: boolean;
  claimableExamined: number;
  claimedAndPublished: number;
  expiredLeasesExamined: number;
  reconciledToPrOpened: number;
  retryEligibleExamined: number;
  retriedAndPublished: number;
}

const INACTIVE_TICK_SUMMARY = {
  claimableExamined: 0,
  claimedAndPublished: 0,
  expiredLeasesExamined: 0,
  reconciledToPrOpened: 0,
  retryEligibleExamined: 0,
  retriedAndPublished: 0,
} as const;

// One full pass: if activated, claim+publish every publication_authorized
// candidate, reconcile every publishing candidate whose lease has expired,
// then retry every publish_failed candidate currently eligible under its
// route contract's bounded auto-retry policy. Pure and directly callable (no
// interval, no lifecycle) so tests exercise the exact logic
// startDeliveryControllerWorker schedules, not a reimplementation of it.
export async function runWorkerTick(db: Db, deps: DeliveryControllerDeps, workerId: string): Promise<WorkerTickSummary> {
  const svc = deliveryControllerService(db, deps);

  if (!(await svc.isWorkerActivated())) {
    return { workerId, activated: false, ...INACTIVE_TICK_SUMMARY };
  }

  // Claiming an expected-409 race (another concurrent tick/replica winning
  // the same candidate) is swallowed below in each of the three phases —
  // that's claimForPublish()'s own concurrency-safety doing exactly its
  // job, not a tick failure.
  const isExpectedConflict = (error: unknown) => error instanceof HttpError && error.status === 409;

  const claimableIds = await svc.listClaimableCandidateIds();
  let claimedAndPublished = 0;
  for (const id of claimableIds) {
    try {
      const result = await svc.publish(id, workerId);
      if (result.state === "pr_opened") claimedAndPublished += 1;
    } catch (error) {
      if (!isExpectedConflict(error)) throw error;
    }
  }

  const expiredLeaseIds = await svc.listExpiredLeaseCandidateIds();
  let reconciledToPrOpened = 0;
  for (const id of expiredLeaseIds) {
    const outcome = await svc.reconcileExpiredLease(id, workerId);
    // outcome is null if another tick/worker already reclaimed this exact
    // lease first — same expected race, already handled inside
    // reconcileExpiredLease() itself (it returns null rather than throwing).
    if (outcome?.state === "pr_opened") reconciledToPrOpened += 1;
  }

  const retryEligibleIds = await svc.listRetryableFailedCandidateIds();
  let retriedAndPublished = 0;
  for (const id of retryEligibleIds) {
    try {
      const result = await svc.publish(id, workerId);
      if (result.state === "pr_opened") retriedAndPublished += 1;
    } catch (error) {
      if (!isExpectedConflict(error)) throw error;
    }
  }

  return {
    workerId,
    activated: true,
    claimableExamined: claimableIds.length,
    claimedAndPublished,
    expiredLeasesExamined: expiredLeaseIds.length,
    reconciledToPrOpened,
    retryEligibleExamined: retryEligibleIds.length,
    retriedAndPublished,
  };
}

export interface DeliveryControllerWorkerOptions {
  /** Milliseconds between ticks once started. Default 30s. */
  intervalMs?: number;
  /** Identity recorded as the actor/leaseOwner on everything this worker
   * does — distinct per process/replica so a stuck lease's delivery_transitions
   * history shows which worker instance actually held it. */
  workerId?: string;
  /** If true, begins ticking immediately on construction. Driven in app.ts
   * by the PAPERCLIP_DELIVERY_WORKER_ENABLED env var (default off) — the
   * deploy-time half of the worker's two-layer activation gate. Starting
   * the scheduler is NOT the same as the worker doing real work: every tick
   * still calls isWorkerActivated() first (see runWorkerTick() above) and
   * does nothing unless a human has separately, explicitly activated it —
   * see delivery_worker_activation.ts. */
  autoStart?: boolean;
  onTickError?: (error: unknown) => void;
}

export interface DeliveryControllerWorker {
  readonly workerId: string;
  start(): void;
  stop(): void;
  /** Runs exactly one tick immediately, independent of the interval
   * schedule — the same function tests call directly. */
  runTick(): Promise<WorkerTickSummary>;
}

export function startDeliveryControllerWorker(
  db: Db,
  deps: DeliveryControllerDeps,
  options: DeliveryControllerWorkerOptions = {},
): DeliveryControllerWorker {
  const workerId = options.workerId ?? `worker:${randomUUID()}`;
  const intervalMs = options.intervalMs ?? 30_000;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<WorkerTickSummary> {
    return runWorkerTick(db, deps, workerId);
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      tick().catch((error) => options.onTickError?.(error));
    }, intervalMs);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  if (options.autoStart) start();

  return { workerId, start, stop, runTick: tick };
}
