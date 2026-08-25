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
    `Skipping delivery-controller worker-activation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

// The worker's actual on/off switch — a deployed scheduler that ticks on
// schedule must still do NOTHING to a real remote until a human has
// explicitly, durably activated it. See delivery_worker_activation.ts's own
// header for the two-layer design; this file only exercises the DB-recorded
// layer (isWorkerActivated/activateWorker/deactivateWorker), since the env
// var layer is a plain app.ts startup read, not something with its own
// runtime behavior to test here.
describeEmbeddedPostgres("delivery controller — worker activation gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-delivery-controller-activation-");
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
    return bootstrap.evaluatePublicationAuthorization(candidate.id, "system:evaluator");
  }

  it("isWorkerActivated is false with no activation row ever created", async () => {
    expect(await service().isWorkerActivated()).toBe(false);
  });

  it("activateWorker creates an active row and isWorkerActivated flips true", async () => {
    const svc = service();
    const activation = await svc.activateWorker("human:owner", "go-live");
    expect(activation.status).toBe("active");
    expect(activation.authorizedByUserId).toBe("human:owner");
    expect(activation.reason).toBe("go-live");
    expect(await svc.isWorkerActivated()).toBe(true);
  });

  it("activateWorker is idempotent — calling it twice does not create a second active row", async () => {
    const svc = service();
    const first = await svc.activateWorker("human:owner");
    const second = await svc.activateWorker("human:owner");
    expect(second.id).toBe(first.id);
    const status = await svc.getWorkerActivationStatus();
    expect(status.active).toHaveLength(1);
  });

  it("deactivateWorker revokes the active row and isWorkerActivated flips back false", async () => {
    const svc = service();
    await svc.activateWorker("human:owner");
    expect(await svc.isWorkerActivated()).toBe(true);

    const revoked = await svc.deactivateWorker("human:owner");
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.status).toBe("revoked");
    expect(revoked[0]?.revokedByUserId).toBe("human:owner");
    expect(await svc.isWorkerActivated()).toBe(false);
  });

  it("a deployed-but-not-activated worker tick does NOTHING — a claimable candidate sits untouched", async () => {
    await seedAuthorizedCandidate();
    const gitClient = makeFakeGitClient();
    const githubClient = makeFakeGitHubClient();
    const deps: DeliveryControllerDeps = { gitClient, githubClient, sourceArtifact: makeFakeSourceArtifact() };

    // No activateWorker() call — exactly what a fresh deploy looks like
    // before a human has explicitly opted in.
    const summary = await runWorkerTick(db, deps, "worker:tick-1");

    expect(summary.activated).toBe(false);
    expect(summary.claimableExamined).toBe(0);
    expect(summary.claimedAndPublished).toBe(0);
    expect(gitClient.pushExactSha).not.toHaveBeenCalled();
    expect(githubClient.createPullRequest).not.toHaveBeenCalled();
  });

  it("after activateWorker, the exact same claimable candidate the previous tick ignored gets claimed and published", async () => {
    const candidate = await seedAuthorizedCandidate();
    const gitClient = makeFakeGitClient();
    const githubClient = makeFakeGitHubClient();
    const deps: DeliveryControllerDeps = { gitClient, githubClient, sourceArtifact: makeFakeSourceArtifact() };

    const before = await runWorkerTick(db, deps, "worker:tick-1");
    expect(before.activated).toBe(false);
    expect(gitClient.pushExactSha).not.toHaveBeenCalled();

    await service().activateWorker("human:owner");
    const after = await runWorkerTick(db, deps, "worker:tick-2");

    expect(after.activated).toBe(true);
    expect(after.claimableExamined).toBe(1);
    expect(after.claimedAndPublished).toBe(1);
    expect(gitClient.pushExactSha).toHaveBeenCalledTimes(1);
    const row = await db.select().from(deliveryCandidates).where(eq(deliveryCandidates.id, candidate.id));
    expect(row[0]?.state).toBe("pr_opened");
  });

  it("deactivating mid-operation stops the NEXT tick from claiming further work, without touching what already landed", async () => {
    const candidate = await seedAuthorizedCandidate();
    const svc = service();
    await svc.activateWorker("human:owner");
    const deps: DeliveryControllerDeps = { gitClient: makeFakeGitClient(), githubClient: makeFakeGitHubClient(), sourceArtifact: makeFakeSourceArtifact() };

    const first = await runWorkerTick(db, deps, "worker:tick-1");
    expect(first.claimedAndPublished).toBe(1);

    await svc.deactivateWorker("human:owner");

    // A second candidate authorized AFTER deactivation must NOT be picked up.
    const contract = (await db.select().from(deliveryRouteContracts))[0]!;
    const second = await svc.submitCandidate({
      repo: "acme/widgets", branch: "feat/thing", baseBranch: "master", sha: "b".repeat(40),
      sourceWorktreePath: "/tmp/y", validationReceipt: { testsPass: true }, submittedByActor: "human:tester",
    });
    await svc.evaluatePublicationAuthorization(second.id, "system:evaluator");

    const gitClient2 = makeFakeGitClient();
    const tick2 = await runWorkerTick(db, { gitClient: gitClient2, githubClient: makeFakeGitHubClient(), sourceArtifact: makeFakeSourceArtifact() }, "worker:tick-2");
    expect(tick2.activated).toBe(false);
    expect(tick2.claimedAndPublished).toBe(0);
    expect(gitClient2.pushExactSha).not.toHaveBeenCalled();

    // The FIRST candidate's already-landed pr_opened state is untouched.
    const firstRow = await db.select().from(deliveryCandidates).where(eq(deliveryCandidates.id, candidate.id));
    expect(firstRow[0]?.state).toBe("pr_opened");
    void contract;
  });
});
