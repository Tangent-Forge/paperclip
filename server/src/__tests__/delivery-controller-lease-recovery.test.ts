import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, deliveryCandidates, deliveryRouteContracts, deliveryTransitions, deliveryWorkerActivations } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  deliveryControllerService,
  type DeliveryControllerDeps,
  type DeliveryGitClient,
  type DeliveryGitHubClient,
  type PullRequestInfo,
} from "../services/delivery-controller.ts";
import { runWorkerTick } from "../services/delivery-controller-worker.ts";
import type { DeliverySourceArtifactCapturer } from "../services/delivery-source-artifact.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping delivery-controller lease-recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA_A = "a".repeat(40);

function samplePr(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return { number: 42, url: "https://github.com/acme/widgets/pull/42", headSha: SHA_A, baseBranch: "master", state: "open", ...overrides };
}

function makeFakeGitClient(overrides: Partial<DeliveryGitClient> = {}): DeliveryGitClient & Record<string, ReturnType<typeof vi.fn>> {
  return {
    pushExactSha: vi.fn(overrides.pushExactSha ?? (async () => {})),
    readRemoteBranchHead: vi.fn(overrides.readRemoteBranchHead ?? (async () => SHA_A)),
  } as never;
}
function makeFakeGitHubClient(overrides: Partial<DeliveryGitHubClient> = {}): DeliveryGitHubClient & Record<string, ReturnType<typeof vi.fn>> {
  return {
    findOpenPullRequest: vi.fn(overrides.findOpenPullRequest ?? (async () => null)),
    createPullRequest: vi.fn(overrides.createPullRequest ?? (async () => samplePr())),
    readPullRequest: vi.fn(overrides.readPullRequest ?? (async () => samplePr())),
  } as never;
}
function makeFakeSourceArtifact(): DeliverySourceArtifactCapturer {
  return { captureArtifact: async () => ({ artifactPath: "/fake/artifact.git", capturedAt: new Date() }) };
}

// The whole point of this file: a candidate stuck in "publishing" because its
// claimant crashed must recover with NOTHING but a worker tick — no manual
// SQL, no human touching the row. Every "simulate a crash" step below
// represents what a real crash leaves behind (an expired lease and whatever
// partial remote state existed at the moment of death), never a repair.
describeEmbeddedPostgres("delivery controller — lease expiry and crash recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-delivery-controller-lease-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(deliveryTransitions);
    await db.delete(deliveryCandidates);
    await db.delete(deliveryRouteContracts);
    await db.delete(deliveryWorkerActivations);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function service(deps: Partial<DeliveryControllerDeps> = {}) {
    return deliveryControllerService(db, {
      gitClient: deps.gitClient ?? makeFakeGitClient(),
      githubClient: deps.githubClient ?? makeFakeGitHubClient(),
      sourceArtifact: deps.sourceArtifact ?? makeFakeSourceArtifact(),
    });
  }

  async function seedAuthorizedCandidate() {
    const bootstrap = service();
    await bootstrap.createRouteContract({
      repo: "acme/widgets", branchPattern: "feat/thing", baseBranch: "master", action: "publish",
      authorizedByUserId: "human:owner",
    });
    const candidate = await bootstrap.submitCandidate({
      repo: "acme/widgets", branch: "feat/thing", baseBranch: "master", sha: SHA_A,
      sourceWorktreePath: "/tmp/x", validationReceipt: { testsPass: true }, submittedByActor: "human:tester",
    });
    const authorized = await bootstrap.evaluatePublicationAuthorization(candidate.id, "system:evaluator");
    expect(authorized.state).toBe("publication_authorized");
    return authorized;
  }

  // Directly forces a lease into the past — this is the ONLY place any of
  // these tests touches the database directly, and it exists purely to
  // fabricate "time has passed since a crash", not to repair anything.
  async function expireLease(candidateId: string) {
    await db.update(deliveryCandidates).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(deliveryCandidates.id, candidateId));
  }

  it("claimForPublish sets a lease attempt id and a future expiry", async () => {
    const candidate = await seedAuthorizedCandidate();
    const svc = service();
    const claim = await svc.claimForPublish(candidate.id, "system:publisher");
    expect(claim.kind).toBe("claimed");
    expect(claim.candidate.leaseAttemptId).toBeTruthy();
    expect(claim.candidate.leaseExpiresAt).toBeInstanceOf(Date);
    expect(claim.candidate.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(claim.candidate.leaseOwner).toBe("system:publisher");
  });

  it("reconcileExpiredLease is a no-op for a candidate whose lease has NOT expired — a live claim is never touched", async () => {
    const candidate = await seedAuthorizedCandidate();
    const svc = service();
    const claim = await svc.claimForPublish(candidate.id, "system:publisher");
    const outcome = await svc.reconcileExpiredLease(candidate.id, "system:reconciler");
    expect(outcome).toBeNull();
    const stillOwned = await svc.getCandidate(candidate.id);
    expect(stillOwned.leaseAttemptId).toBe(claim.candidate.leaseAttemptId); // unchanged
  });

  it("crash scenario A — nothing was ever pushed: reconciliation runs the FULL publish from scratch", async () => {
    const candidate = await seedAuthorizedCandidate();
    const deadGitClient = makeFakeGitClient();
    const deadSvc = service({ gitClient: deadGitClient });
    await deadSvc.claimForPublish(candidate.id, "worker:dead-process");
    await expireLease(candidate.id);
    // The dead process never got as far as calling gitClient at all — this
    // is what "crashed before doing anything" looks like from the outside.

    const liveGitClient = makeFakeGitClient({ readRemoteBranchHead: async () => SHA_A });
    const liveGithubClient = makeFakeGitHubClient();
    const liveSvc = service({ gitClient: liveGitClient, githubClient: liveGithubClient });
    const recovered = await liveSvc.reconcileExpiredLease(candidate.id, "worker:recovered");

    expect(recovered?.state).toBe("pr_opened");
    expect(liveGitClient.pushExactSha).toHaveBeenCalledTimes(1);
    expect(liveGithubClient.createPullRequest).toHaveBeenCalledTimes(1);
    expect(recovered?.leaseOwner).toBe("worker:recovered");

    const transitions = await liveSvc.listTransitions(candidate.id);
    expect(transitions.some((t) => t.reason === "lease expired — reclaimed for reconciliation")).toBe(true);
  });

  it("crash scenario B — push landed but no PR yet: reconciliation completes just the PR step", async () => {
    const candidate = await seedAuthorizedCandidate();
    await service().claimForPublish(candidate.id, "worker:dead-process");
    await expireLease(candidate.id);
    // Simulating "the dead process's push actually succeeded on the real
    // remote before it died" — readRemoteBranchHead already reports the
    // pushed sha, findOpenPullRequest reports nothing yet.

    const gitClient = makeFakeGitClient({ readRemoteBranchHead: async () => SHA_A });
    const githubClient = makeFakeGitHubClient({ findOpenPullRequest: async () => null });
    const recovered = await service({ gitClient, githubClient }).reconcileExpiredLease(candidate.id, "worker:recovered");

    expect(recovered?.state).toBe("pr_opened");
    // Re-pushing the identical sha is a harmless idempotent no-op — this
    // proves the SAME reconciliation logic handles both "not done" and
    // "already done" without needing to distinguish them beforehand.
    expect(gitClient.pushExactSha).toHaveBeenCalledTimes(1);
    expect(githubClient.createPullRequest).toHaveBeenCalledTimes(1);
  });

  it("crash scenario C — push AND PR already done, just never recorded: reconciliation discovers and finalizes without redoing PR creation", async () => {
    const candidate = await seedAuthorizedCandidate();
    await service().claimForPublish(candidate.id, "worker:dead-process");
    await expireLease(candidate.id);
    // The dead process finished everything — push landed, PR exists — and
    // died only between "PR created" and "record pr_opened in the DB".

    const gitClient = makeFakeGitClient({ readRemoteBranchHead: async () => SHA_A });
    const existingPr = samplePr({ number: 99, url: "https://github.com/acme/widgets/pull/99" });
    const githubClient = makeFakeGitHubClient({
      findOpenPullRequest: async () => existingPr,
      readPullRequest: async () => existingPr,
    });
    const recovered = await service({ gitClient, githubClient }).reconcileExpiredLease(candidate.id, "worker:recovered");

    expect(recovered?.state).toBe("pr_opened");
    expect(recovered?.prNumber).toBe(99);
    // The load-bearing assertion for this scenario: no duplicate PR.
    expect(githubClient.createPullRequest).not.toHaveBeenCalled();
  });

  it("no human database repair: a single runWorkerTick() call, given nothing but a crashed lease, reaches pr_opened", async () => {
    const candidate = await seedAuthorizedCandidate();
    await service().claimForPublish(candidate.id, "worker:dead-process");
    await expireLease(candidate.id);

    const gitClient = makeFakeGitClient({ readRemoteBranchHead: async () => SHA_A });
    const githubClient = makeFakeGitHubClient();
    const deps: DeliveryControllerDeps = { gitClient, githubClient, sourceArtifact: makeFakeSourceArtifact() };
    await service().activateWorker("human:owner"); // the worker's own gate — see delivery_worker_activation.ts

    // The ENTIRE recovery action: exactly the function a scheduled worker
    // calls on its own, with no additional setup and no direct database
    // write beyond the crash-simulating expireLease() above.
    const summary = await runWorkerTick(db, deps, "worker:tick-1");

    expect(summary.activated).toBe(true);
    expect(summary.expiredLeasesExamined).toBe(1);
    expect(summary.reconciledToPrOpened).toBe(1);
    const finalRow = await db.select().from(deliveryCandidates).where(eq(deliveryCandidates.id, candidate.id));
    expect(finalRow[0]?.state).toBe("pr_opened");
  });

  it("runWorkerTick automatically claims and publishes a freshly-authorized candidate — the normal path is the worker, not a person calling /publish", async () => {
    const candidate = await seedAuthorizedCandidate();
    const gitClient = makeFakeGitClient({ readRemoteBranchHead: async () => SHA_A });
    const githubClient = makeFakeGitHubClient();
    const deps: DeliveryControllerDeps = { gitClient, githubClient, sourceArtifact: makeFakeSourceArtifact() };
    await service().activateWorker("human:owner");

    const summary = await runWorkerTick(db, deps, "worker:tick-1");

    expect(summary.activated).toBe(true);
    expect(summary.claimableExamined).toBe(1);
    expect(summary.claimedAndPublished).toBe(1);
    const finalRow = await db.select().from(deliveryCandidates).where(eq(deliveryCandidates.id, candidate.id));
    expect(finalRow[0]?.state).toBe("pr_opened");
    expect(finalRow[0]?.leaseOwner).toBe("worker:tick-1");
  });

  it("runWorkerTick never automatically retries publish_failed candidates — those stay for operator-triggered /publish", async () => {
    const candidate = await seedAuthorizedCandidate();
    const failingGitClient = makeFakeGitClient({ pushExactSha: async () => { throw new Error("network unreachable"); } });
    await service({ gitClient: failingGitClient }).publish(candidate.id, "system:publisher");
    const failed = await db.select().from(deliveryCandidates).where(eq(deliveryCandidates.id, candidate.id));
    expect(failed[0]?.state).toBe("publish_failed");

    const workingGitClient = makeFakeGitClient({ readRemoteBranchHead: async () => SHA_A });
    const deps: DeliveryControllerDeps = { gitClient: workingGitClient, githubClient: makeFakeGitHubClient(), sourceArtifact: makeFakeSourceArtifact() };
    await service().activateWorker("human:owner");
    const summary = await runWorkerTick(db, deps, "worker:tick-1");

    expect(summary.activated).toBe(true);
    expect(summary.claimableExamined).toBe(0);
    expect(summary.claimedAndPublished).toBe(0);
    // A generic Error (no recognized HTTP status or network errno code)
    // classifies "permanent" by default — see classifyPublishFailure() — so
    // this is excluded from retry regardless of the route contract's
    // autoRetryLimit. See the dedicated retry-backoff test file for the
    // opted-in, transient-classified case.
    expect(summary.retryEligibleExamined).toBe(0);
    expect(summary.retriedAndPublished).toBe(0);
    expect(workingGitClient.pushExactSha).not.toHaveBeenCalled();
    const stillFailed = await db.select().from(deliveryCandidates).where(eq(deliveryCandidates.id, candidate.id));
    expect(stillFailed[0]?.state).toBe("publish_failed"); // untouched by the tick
  });

  it("two concurrent reconciliation attempts on the same expired lease: only one wins, never a duplicate push/PR", async () => {
    const candidate = await seedAuthorizedCandidate();
    await service().claimForPublish(candidate.id, "worker:dead-process");
    await expireLease(candidate.id);

    const gitClient = makeFakeGitClient({ readRemoteBranchHead: async () => SHA_A });
    const githubClient = makeFakeGitHubClient();
    const svc = service({ gitClient, githubClient });

    const [a, b] = await Promise.all([
      svc.reconcileExpiredLease(candidate.id, "worker:reconciler-a"),
      svc.reconcileExpiredLease(candidate.id, "worker:reconciler-b"),
    ]);
    const outcomes = [a, b].filter((x): x is NonNullable<typeof x> => x !== null);
    expect(outcomes).toHaveLength(1); // exactly one reconciler actually reclaimed and ran
    expect(gitClient.pushExactSha).toHaveBeenCalledTimes(1);
    expect(githubClient.createPullRequest).toHaveBeenCalledTimes(1);
  });
});
