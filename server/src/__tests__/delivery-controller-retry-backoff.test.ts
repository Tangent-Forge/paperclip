import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  createDb,
  deliveryCandidates,
  deliveryRouteContracts,
  deliveryTransitions,
  deliveryWorkerActivations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  classifyPublishFailure,
  deliveryControllerService,
  type DeliveryControllerDeps,
  type DeliveryGitClient,
  type DeliveryGitHubClient,
  type PullRequestInfo,
} from "../services/delivery-controller.ts";
import { runWorkerTick } from "../services/delivery-controller-worker.ts";
import type { DeliverySourceArtifactCapturer } from "../services/delivery-source-artifact.ts";
import { HttpError } from "../errors.js";

// --- classifyPublishFailure: pure function, no DB needed ------------------
describe("classifyPublishFailure", () => {
  it("classifies retry-worthy HTTP statuses as transient", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(classifyPublishFailure(new HttpError(status, "x"))).toBe("transient");
    }
  });

  it("classifies other HTTP statuses as permanent", () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(classifyPublishFailure(new HttpError(status, "x"))).toBe("permanent");
    }
  });

  it("classifies recognized network errno codes as transient", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "EPIPE"]) {
      const error = Object.assign(new Error("network"), { code });
      expect(classifyPublishFailure(error)).toBe("transient");
    }
  });

  it("defaults an unrecognized error shape to permanent — never assumed safe to auto-retry", () => {
    expect(classifyPublishFailure(new Error("something odd"))).toBe("permanent");
    expect(classifyPublishFailure("a bare string throw")).toBe("permanent");
    expect(classifyPublishFailure(null)).toBe("permanent");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping delivery-controller retry-backoff tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

// Bounded automatic retry: a route contract must EXPLICITLY opt in
// (autoRetryLimit > 0, default 0) before the worker ever touches a
// publish_failed candidate again — and even then, only while the failure was
// classified transient, the exponential backoff window has elapsed, and the
// contract's own retry cap hasn't been reached. Anything else stays a
// human's problem via /publish, forever, same as before this file existed.
describeEmbeddedPostgres("delivery controller — bounded retry/backoff policy", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-delivery-controller-retry-");
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

  async function seedAuthorizedCandidate(contractOverrides: { autoRetryLimit?: number; retryBackoffSeconds?: number } = {}) {
    const bootstrap = service();
    await bootstrap.createRouteContract({
      repo: "acme/widgets", branchPattern: "feat/thing", baseBranch: "master", action: "publish",
      authorizedByUserId: "human:owner", ...contractOverrides,
    });
    const candidate = await bootstrap.submitCandidate({
      repo: "acme/widgets", branch: "feat/thing", baseBranch: "master", sha: SHA_A,
      sourceWorktreePath: "/tmp/x", validationReceipt: { testsPass: true }, submittedByActor: "human:tester",
    });
    return bootstrap.evaluatePublicationAuthorization(candidate.id, "system:evaluator");
  }

  // Simulates "the backoff window has elapsed" without a real sleep — the
  // same fabricate-elapsed-time discipline delivery-controller-lease-
  // recovery.test.ts uses for expired leases.
  async function clearBackoff(candidateId: string) {
    await db.update(deliveryCandidates).set({ nextRetryEarliestAt: new Date(Date.now() - 1000) }).where(eq(deliveryCandidates.id, candidateId));
  }

  it("a transient push failure records failureCount, classification, and a future backoff — visible on the row itself", async () => {
    const candidate = await seedAuthorizedCandidate({ autoRetryLimit: 3, retryBackoffSeconds: 60 });
    const failingGitClient = makeFakeGitClient({
      pushExactSha: async () => { throw new HttpError(503, "upstream unavailable"); },
    });
    await service({ gitClient: failingGitClient }).publish(candidate.id, "system:publisher");

    const [row] = await db.select().from(deliveryCandidates).where(eq(deliveryCandidates.id, candidate.id));
    expect(row?.state).toBe("publish_failed");
    expect(row?.failureCount).toBe(1);
    expect(row?.failureClassification).toBe("transient");
    expect(row?.nextRetryEarliestAt).toBeInstanceOf(Date);
    expect(row!.nextRetryEarliestAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("before its backoff window elapses, the worker does not retry a transient failure", async () => {
    const candidate = await seedAuthorizedCandidate({ autoRetryLimit: 3, retryBackoffSeconds: 3600 });
    const failingGitClient = makeFakeGitClient({ pushExactSha: async () => { throw new HttpError(503, "x"); } });
    await service({ gitClient: failingGitClient }).publish(candidate.id, "system:publisher");

    await service().activateWorker("human:owner");
    const workingGitClient = makeFakeGitClient();
    const summary = await runWorkerTick(db, { gitClient: workingGitClient, githubClient: makeFakeGitHubClient(), sourceArtifact: makeFakeSourceArtifact() }, "worker:tick-1");

    expect(summary.retryEligibleExamined).toBe(0);
    expect(summary.retriedAndPublished).toBe(0);
    expect(workingGitClient.pushExactSha).not.toHaveBeenCalled();
    const [row] = await db.select().from(deliveryCandidates).where(eq(deliveryCandidates.id, candidate.id));
    expect(row?.state).toBe("publish_failed"); // untouched
  });

  it("once the backoff window elapses, an activated worker automatically retries a transient failure to success", async () => {
    const candidate = await seedAuthorizedCandidate({ autoRetryLimit: 3, retryBackoffSeconds: 60 });
    const failingGitClient = makeFakeGitClient({ pushExactSha: async () => { throw new HttpError(503, "x"); } });
    await service({ gitClient: failingGitClient }).publish(candidate.id, "system:publisher");
    await clearBackoff(candidate.id);

    await service().activateWorker("human:owner");
    const workingGitClient = makeFakeGitClient();
    const githubClient = makeFakeGitHubClient();
    const summary = await runWorkerTick(db, { gitClient: workingGitClient, githubClient, sourceArtifact: makeFakeSourceArtifact() }, "worker:tick-1");

    expect(summary.retryEligibleExamined).toBe(1);
    expect(summary.retriedAndPublished).toBe(1);
    const [row] = await db.select().from(deliveryCandidates).where(eq(deliveryCandidates.id, candidate.id));
    expect(row?.state).toBe("pr_opened");
  });

  // The read-back verification fix: a failure to even CHECK the push/PR
  // landed (not a genuine mismatch) must reach publish_failed immediately
  // — classified, backed off, eventually auto-retried — rather than being
  // left stuck in "publishing" until lease expiry finally notices. See
  // runPublishExecution()'s two read-back try/catch blocks.
  it("a transient failure to read back the remote branch head lands publish_failed (not stuck in publishing) and is later auto-retried", async () => {
    const candidate = await seedAuthorizedCandidate({ autoRetryLimit: 3, retryBackoffSeconds: 60 });
    const flakyReadBack = makeFakeGitClient({ readRemoteBranchHead: async () => { throw new HttpError(503, "temporarily unavailable"); } });
    const svc = service({ gitClient: flakyReadBack });

    const outcome = await svc.publish(candidate.id, "system:publisher");
    // The critical assertion: NOT left in "publishing" waiting for lease
    // expiry — an uncaught throw here would have done exactly that.
    expect(outcome.state).toBe("publish_failed");
    expect(outcome.failureClassification).toBe("transient");
    expect(outcome.failureCount).toBe(1);
    expect(outcome.nextRetryEarliestAt).toBeInstanceOf(Date);

    await clearBackoff(candidate.id);
    await svc.activateWorker("human:owner");
    const workingGitClient = makeFakeGitClient(); // now succeeds, including read-back
    const summary = await runWorkerTick(db, { gitClient: workingGitClient, githubClient: makeFakeGitHubClient(), sourceArtifact: makeFakeSourceArtifact() }, "worker:tick-1");

    expect(summary.retryEligibleExamined).toBe(1);
    expect(summary.retriedAndPublished).toBe(1);
    const [row] = await db.select().from(deliveryCandidates).where(eq(deliveryCandidates.id, candidate.id));
    expect(row?.state).toBe("pr_opened");
  });

  it("a transient failure to read back the PR lands publish_failed (not stuck in publishing) and is later auto-retried", async () => {
    const candidate = await seedAuthorizedCandidate({ autoRetryLimit: 3, retryBackoffSeconds: 60 });
    const flakyReadBack = makeFakeGitHubClient({ readPullRequest: async () => { throw new HttpError(429, "rate limited"); } });
    const svc = service({ githubClient: flakyReadBack });

    const outcome = await svc.publish(candidate.id, "system:publisher");
    expect(outcome.state).toBe("publish_failed");
    expect(outcome.failureClassification).toBe("transient");

    await clearBackoff(candidate.id);
    await svc.activateWorker("human:owner");
    const summary = await runWorkerTick(db, { gitClient: makeFakeGitClient(), githubClient: makeFakeGitHubClient(), sourceArtifact: makeFakeSourceArtifact() }, "worker:tick-1");

    expect(summary.retriedAndPublished).toBe(1);
    const [row] = await db.select().from(deliveryCandidates).where(eq(deliveryCandidates.id, candidate.id));
    expect(row?.state).toBe("pr_opened");
  });

  // A genuine mismatch (the read-back SUCCEEDED and disagrees) must stay
  // permanent — this is the control case proving the fix didn't loosen
  // real-mismatch handling while fixing the failed-check case above.
  it("a genuine branch-head mismatch (read-back succeeds, disagrees) stays permanent — never auto-retried", async () => {
    const candidate = await seedAuthorizedCandidate({ autoRetryLimit: 3, retryBackoffSeconds: 1 });
    const wrongHead = makeFakeGitClient({ readRemoteBranchHead: async () => "f".repeat(40) });
    const outcome = await service({ gitClient: wrongHead }).publish(candidate.id, "system:publisher");
    expect(outcome.state).toBe("publish_failed");
    expect(outcome.failureClassification).toBe("permanent");

    await clearBackoff(candidate.id);
    await service().activateWorker("human:owner");
    const eligible = await service().listRetryableFailedCandidateIds();
    expect(eligible).toEqual([]);
  });

  it("once failureCount reaches the route contract's autoRetryLimit, the worker stops retrying — human escalation only", async () => {
    const candidate = await seedAuthorizedCandidate({ autoRetryLimit: 1, retryBackoffSeconds: 60 });
    const failingGitClient = makeFakeGitClient({ pushExactSha: async () => { throw new HttpError(503, "x"); } });
    const svc = service({ gitClient: failingGitClient });

    // First failure: failureCount -> 1, which already equals the cap.
    await svc.publish(candidate.id, "system:publisher");
    await clearBackoff(candidate.id);

    await svc.activateWorker("human:owner");
    const summary = await runWorkerTick(db, { gitClient: makeFakeGitClient(), githubClient: makeFakeGitHubClient(), sourceArtifact: makeFakeSourceArtifact() }, "worker:tick-1");

    expect(summary.retryEligibleExamined).toBe(0);
    expect(summary.retriedAndPublished).toBe(0);
    const [row] = await db.select().from(deliveryCandidates).where(eq(deliveryCandidates.id, candidate.id));
    expect(row?.state).toBe("publish_failed");
    expect(row?.failureCount).toBe(1);

    // Human escalation still works via the exact same publish() the
    // operator-triggered /publish route calls.
    const recovered = await service().publish(candidate.id, "human:operator");
    expect(recovered.state).toBe("pr_opened");
  });

  it("a permanently-classified failure is never auto-retried, no matter how high (within the enforced max) the contract's autoRetryLimit is", async () => {
    const candidate = await seedAuthorizedCandidate({ autoRetryLimit: 10, retryBackoffSeconds: 1 }); // the enforced ceiling — see MAX_AUTO_RETRY_LIMIT
    const failingGitClient = makeFakeGitClient({ pushExactSha: async () => { throw new HttpError(422, "rejected"); } });
    await service({ gitClient: failingGitClient }).publish(candidate.id, "system:publisher");
    await clearBackoff(candidate.id);

    const [row] = await db.select().from(deliveryCandidates).where(eq(deliveryCandidates.id, candidate.id));
    expect(row?.failureClassification).toBe("permanent");

    await service().activateWorker("human:owner");
    const workingGitClient = makeFakeGitClient();
    const summary = await runWorkerTick(db, { gitClient: workingGitClient, githubClient: makeFakeGitHubClient(), sourceArtifact: makeFakeSourceArtifact() }, "worker:tick-1");

    expect(summary.retryEligibleExamined).toBe(0);
    expect(workingGitClient.pushExactSha).not.toHaveBeenCalled();
  });

  it("createRouteContract rejects an autoRetryLimit or retryBackoffSeconds above the enforced maximum", async () => {
    const svc = service();
    await expect(
      svc.createRouteContract({
        repo: "acme/widgets", branchPattern: "feat/thing", baseBranch: "master", action: "publish",
        authorizedByUserId: "human:owner", autoRetryLimit: 11,
      }),
    ).rejects.toThrow(/autoRetryLimit must be an integer between 0 and 10/);

    await expect(
      svc.createRouteContract({
        repo: "acme/widgets", branchPattern: "feat/thing", baseBranch: "master", action: "publish",
        authorizedByUserId: "human:owner", retryBackoffSeconds: 86401,
      }),
    ).rejects.toThrow(/retryBackoffSeconds must be an integer between 1 and 86400/);
  });

  it("createRouteContract rejects a negative autoRetryLimit or a non-positive retryBackoffSeconds", async () => {
    const svc = service();
    await expect(
      svc.createRouteContract({
        repo: "acme/widgets", branchPattern: "feat/thing", baseBranch: "master", action: "publish",
        authorizedByUserId: "human:owner", autoRetryLimit: -1,
      }),
    ).rejects.toThrow(/autoRetryLimit must be an integer/);

    await expect(
      svc.createRouteContract({
        repo: "acme/widgets", branchPattern: "feat/thing", baseBranch: "master", action: "publish",
        authorizedByUserId: "human:owner", retryBackoffSeconds: 0,
      }),
    ).rejects.toThrow(/retryBackoffSeconds must be an integer/);
  });

  it("a raw SQL UPDATE raising autoRetryLimit outside createRouteContract is detected as tampering and stops authorizing retries", async () => {
    const candidate = await seedAuthorizedCandidate({ autoRetryLimit: 1, retryBackoffSeconds: 60 });
    const failingGitClient = makeFakeGitClient({ pushExactSha: async () => { throw new HttpError(503, "x"); } });
    const svc = service({ gitClient: failingGitClient });

    // Exhaust the LEGITIMATE cap first — one failure already equals the
    // contract's real autoRetryLimit of 1.
    await svc.publish(candidate.id, "system:publisher");
    await clearBackoff(candidate.id);
    let eligible = await svc.listRetryableFailedCandidateIds();
    expect(eligible).toEqual([]); // correctly capped out under the real, hashed value

    // Now the attack the owner named: bypass createRouteContract entirely
    // and raise the limit directly. contentHash still reflects the OLD
    // (limit=1) value, so this is exactly the kind of out-of-band change
    // contractIsIntact() exists to catch.
    const [row] = await db.select().from(deliveryCandidates).where(eq(deliveryCandidates.id, candidate.id));
    await db.update(deliveryRouteContracts).set({ autoRetryLimit: 10 }).where(eq(deliveryRouteContracts.id, row!.routeContractId!));

    eligible = await svc.listRetryableFailedCandidateIds();
    expect(eligible).toEqual([]); // tampered contract authorizes nothing — NOT retried just because the raw column now allows it

    // The exact same claim path (claimForPublish, called by publish()) also
    // independently refuses it — belt AND suspenders, not just the
    // eligibility list.
    const stillBlocked = await svc.publish(candidate.id, "human:operator");
    expect(stillBlocked.state).toBe("publication_blocked");
    expect(stillBlocked.blockedReason).toMatch(/integrity check/);
  });

  it("a route contract with autoRetryLimit left at its default (0) never auto-retries, even a transient failure with elapsed backoff", async () => {
    const candidate = await seedAuthorizedCandidate(); // no overrides — autoRetryLimit defaults to 0
    const failingGitClient = makeFakeGitClient({ pushExactSha: async () => { throw new HttpError(503, "x"); } });
    await service({ gitClient: failingGitClient }).publish(candidate.id, "system:publisher");
    await clearBackoff(candidate.id);

    const [row] = await db.select().from(deliveryCandidates).where(eq(deliveryCandidates.id, candidate.id));
    expect(row?.failureClassification).toBe("transient"); // it WOULD be eligible, but for the limit

    await service().activateWorker("human:owner");
    const workingGitClient = makeFakeGitClient();
    const summary = await runWorkerTick(db, { gitClient: workingGitClient, githubClient: makeFakeGitHubClient(), sourceArtifact: makeFakeSourceArtifact() }, "worker:tick-1");

    expect(summary.retryEligibleExamined).toBe(0);
    expect(workingGitClient.pushExactSha).not.toHaveBeenCalled();
  });
});
