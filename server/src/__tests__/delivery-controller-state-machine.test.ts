import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, deliveryCandidates, deliveryRouteContracts, deliveryTransitions } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  deliveryControllerService,
  describeNextAction,
  type DeliveryGitClient,
  type DeliveryGitHubClient,
  type PullRequestInfo,
} from "../services/delivery-controller.ts";
import type { DeliverySourceArtifactCapturer } from "../services/delivery-source-artifact.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping delivery-controller state machine tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Never a real push, PR, merge, deploy, or activation anywhere in this file —
// every test uses in-memory fakes for DeliveryGitClient/DeliveryGitHubClient.
// Real-adapter mechanics (actual git push/read-back against a local fixture
// repo) are proven separately in delivery-publisher-real-adapters.test.ts.
// These tests are about the STATE MACHINE: what state a candidate lands in
// given what its collaborators report, not whether the collaborators
// themselves work.
function makeFakeGitClient(overrides: Partial<DeliveryGitClient> = {}): DeliveryGitClient & {
  pushExactSha: ReturnType<typeof vi.fn>;
  readRemoteBranchHead: ReturnType<typeof vi.fn>;
} {
  return {
    pushExactSha: vi.fn(overrides.pushExactSha ?? (async () => {})),
    readRemoteBranchHead: vi.fn(overrides.readRemoteBranchHead ?? (async (input: { branch: string }) => "unset")),
  } as never;
}

function makeFakeGitHubClient(overrides: Partial<DeliveryGitHubClient> = {}): DeliveryGitHubClient & {
  findOpenPullRequest: ReturnType<typeof vi.fn>;
  createPullRequest: ReturnType<typeof vi.fn>;
  readPullRequest: ReturnType<typeof vi.fn>;
} {
  return {
    findOpenPullRequest: vi.fn(overrides.findOpenPullRequest ?? (async () => null)),
    createPullRequest: vi.fn(overrides.createPullRequest ?? (async () => {
      throw new Error("createPullRequest not configured for this test");
    })),
    readPullRequest: vi.fn(overrides.readPullRequest ?? (async () => null)),
  } as never;
}

function samplePr(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    number: 42,
    url: "https://github.com/acme/widgets/pull/42",
    headSha: "a".repeat(40),
    baseBranch: "master",
    state: "open",
    ...overrides,
  };
}

// This suite is about the STATE MACHINE, not artifact capture — real,
// git-backed capture/validation is proven separately in
// delivery-source-artifact.test.ts. Every submission here gets a fake,
// always-succeeding capturer with a fixed, fake artifact path.
function makeFakeSourceArtifact(artifactPath = "/fake/artifact.git"): DeliverySourceArtifactCapturer {
  return { captureArtifact: async () => ({ artifactPath, capturedAt: new Date() }) };
}

describeEmbeddedPostgres("delivery controller — state machine", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-delivery-controller-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // delivery_transitions references delivery_candidates; delivery_candidates
    // references delivery_route_contracts — children before parents.
    await db.delete(deliveryTransitions);
    await db.delete(deliveryCandidates);
    await db.delete(deliveryRouteContracts);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const SHA_A = "a".repeat(40);
  const SHA_B = "b".repeat(40);

  function service(gitClient?: DeliveryGitClient, githubClient?: DeliveryGitHubClient) {
    return deliveryControllerService(db, {
      gitClient: gitClient ?? makeFakeGitClient(),
      githubClient: githubClient ?? makeFakeGitHubClient(),
      sourceArtifact: makeFakeSourceArtifact(),
    });
  }

  // --- submitCandidate -------------------------------------------------

  it("submitCandidate creates a candidate_verified row with an initial transition", async () => {
    const svc = service();
    const candidate = await svc.submitCandidate({
      repo: "acme/widgets",
      branch: "feat/thing",
      baseBranch: "master",
      sha: SHA_A,
      sourceWorktreePath: "/tmp/fake-worktree",
      validationReceipt: { testsPass: true, typecheckPass: true },
      submittedByActor: "human:tester",
    });
    expect(candidate.state).toBe("candidate_verified");
    expect(candidate.sha).toBe(SHA_A);

    const transitions = await svc.listTransitions(candidate.id);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ fromState: null, toState: "candidate_verified", actor: "human:tester" });
  });

  it("submitCandidate is idempotent for the same (repo, sha) — returns the existing row, does not duplicate", async () => {
    const svc = service();
    const input = {
      repo: "acme/widgets",
      branch: "feat/thing",
      baseBranch: "master",
      sha: SHA_A,
      sourceWorktreePath: "/tmp/fake-worktree",
      validationReceipt: { testsPass: true },
      submittedByActor: "human:tester",
    };
    const first = await svc.submitCandidate(input);
    const second = await svc.submitCandidate({ ...input, submittedByActor: "human:someone-else" });
    expect(second.id).toBe(first.id);
    expect(second.submittedByActor).toBe("human:tester"); // untouched by the second call

    const rows = await db.select().from(deliveryCandidates).where(eq(deliveryCandidates.sha, SHA_A));
    expect(rows).toHaveLength(1);
  });

  it("submitCandidate rejects a non-exact-SHA ref and an empty validation receipt", async () => {
    const svc = service();
    await expect(
      svc.submitCandidate({
        repo: "acme/widgets", branch: "feat/thing", baseBranch: "master",
        sha: "abc123", sourceWorktreePath: "/tmp/fake-worktree", validationReceipt: { ok: true }, submittedByActor: "human:tester",
      }),
    ).rejects.toThrow(/40-character/);
    await expect(
      svc.submitCandidate({
        repo: "acme/widgets", branch: "feat/thing", baseBranch: "master",
        sha: SHA_A, sourceWorktreePath: "/tmp/fake-worktree", validationReceipt: {}, submittedByActor: "human:tester",
      }),
    ).rejects.toThrow(/non-empty object/);
  });

  // --- route contracts ---------------------------------------------------

  it("createRouteContract requires a non-empty authorizedByUserId and computes a stable contentHash", async () => {
    const svc = service();
    await expect(
      svc.createRouteContract({
        repo: "acme/widgets", branchPattern: "feat/thing", baseBranch: "master", action: "publish",
        authorizedByUserId: "",
      }),
    ).rejects.toThrow(/authorizedByUserId/);

    const contract = await svc.createRouteContract({
      repo: "acme/widgets", branchPattern: "feat/thing", baseBranch: "master", action: "publish",
      authorizedByUserId: "human:owner",
    });
    expect(contract.status).toBe("active");
    expect(contract.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  // The DB-level half of the bounded-retry enforcement — independent of
  // createRouteContract()'s own validation, which a raw SQL statement
  // bypasses entirely by definition. See MAX_AUTO_RETRY_LIMIT/
  // MAX_RETRY_BACKOFF_SECONDS in delivery_route_contracts.ts.
  // The DB-level half of the bounded-retry enforcement — independent of
  // createRouteContract()'s own validation, which a raw SQL statement
  // bypasses entirely by definition. See MAX_AUTO_RETRY_LIMIT/
  // MAX_RETRY_BACKOFF_SECONDS in delivery_route_contracts.ts. postgres-js
  // wraps the real Postgres error in `.cause` — the constraint name/detail
  // live there, not in the top-level "Failed query: ..." message.
  async function expectCheckConstraintViolation(promise: Promise<unknown>, constraintName: string) {
    await expect(promise).rejects.toThrow();
    try {
      await promise;
      expect.unreachable("expected the insert to reject");
    } catch (error) {
      const cause = (error as { cause?: unknown }).cause;
      expect(String(cause)).toContain(constraintName);
    }
  }

  it("the database itself refuses an autoRetryLimit or retryBackoffSeconds outside the enforced bounds, even via raw SQL that never goes through createRouteContract", async () => {
    await expectCheckConstraintViolation(
      db.execute(
        sql`insert into delivery_route_contracts (repo, branch_pattern, base_branch, action, content_hash, authorized_by_user_id, auto_retry_limit)
            values ('acme/widgets', 'feat/thing', 'master', 'publish', 'deadbeef', 'human:owner', 11)`,
      ),
      "delivery_route_contracts_auto_retry_limit_check",
    );

    await expectCheckConstraintViolation(
      db.execute(
        sql`insert into delivery_route_contracts (repo, branch_pattern, base_branch, action, content_hash, authorized_by_user_id, retry_backoff_seconds)
            values ('acme/widgets', 'feat/thing', 'master', 'publish', 'deadbeef', 'human:owner', 86401)`,
      ),
      "delivery_route_contracts_retry_backoff_seconds_check",
    );

    // The boundary value itself is accepted — this is a ceiling, not an
    // off-by-one exclusion of the max.
    await expect(
      db.execute(
        sql`insert into delivery_route_contracts (repo, branch_pattern, base_branch, action, content_hash, authorized_by_user_id, auto_retry_limit)
            values ('acme/widgets', 'feat/thing', 'master', 'publish', 'deadbeef', 'human:owner', 10)`,
      ),
    ).resolves.toBeDefined();
  });

  it("revokeRouteContract flips status and records who/when", async () => {
    const svc = service();
    const contract = await svc.createRouteContract({
      repo: "acme/widgets", branchPattern: "feat/thing", baseBranch: "master", action: "publish",
      authorizedByUserId: "human:owner",
    });
    const revoked = await svc.revokeRouteContract(contract.id, "human:owner");
    expect(revoked.status).toBe("revoked");
    expect(revoked.revokedByUserId).toBe("human:owner");
    expect(revoked.revokedAt).not.toBeNull();
  });

  // --- evaluatePublicationAuthorization -----------------------------------

  it("blocks with a specific reason when no active route contract matches", async () => {
    const svc = service();
    const candidate = await svc.submitCandidate({
      repo: "acme/widgets", branch: "feat/thing", baseBranch: "master",
      sha: SHA_A, sourceWorktreePath: "/tmp/fake-worktree", validationReceipt: { testsPass: true }, submittedByActor: "human:tester",
    });
    const result = await svc.evaluatePublicationAuthorization(candidate.id, "system:evaluator");
    expect(result.state).toBe("publication_blocked");
    expect(result.blockedReason).toMatch(/No active route contract/);
  });

  it("authorizes when an active matching contract exists with no constraints", async () => {
    const svc = service();
    await svc.createRouteContract({
      repo: "acme/widgets", branchPattern: "feat/thing", baseBranch: "master", action: "publish",
      authorizedByUserId: "human:owner",
    });
    const candidate = await svc.submitCandidate({
      repo: "acme/widgets", branch: "feat/thing", baseBranch: "master",
      sha: SHA_A, sourceWorktreePath: "/tmp/fake-worktree", validationReceipt: { testsPass: true }, submittedByActor: "human:tester",
    });
    const result = await svc.evaluatePublicationAuthorization(candidate.id, "system:evaluator");
    expect(result.state).toBe("publication_authorized");
    expect(result.routeContractId).not.toBeNull();
  });

  it("evaluates requiredEvidenceKeys constraints — missing evidence blocks with the specific missing keys named", async () => {
    const svc = service();
    await svc.createRouteContract({
      repo: "acme/widgets", branchPattern: "feat/thing", baseBranch: "master", action: "publish",
      constraints: { requiredEvidenceKeys: ["testsPass", "typecheckPass"] },
      authorizedByUserId: "human:owner",
    });
    const candidate = await svc.submitCandidate({
      repo: "acme/widgets", branch: "feat/thing", baseBranch: "master",
      sha: SHA_A, sourceWorktreePath: "/tmp/fake-worktree", validationReceipt: { testsPass: true }, submittedByActor: "human:tester",
    });
    const result = await svc.evaluatePublicationAuthorization(candidate.id, "system:evaluator");
    expect(result.state).toBe("publication_blocked");
    expect(result.blockedReason).toContain("typecheckPass");
  });

  it("authorizes once all required evidence keys are present", async () => {
    const svc = service();
    await svc.createRouteContract({
      repo: "acme/widgets", branchPattern: "feat/thing", baseBranch: "master", action: "publish",
      constraints: { requiredEvidenceKeys: ["testsPass", "typecheckPass"] },
      authorizedByUserId: "human:owner",
    });
    const candidate = await svc.submitCandidate({
      repo: "acme/widgets", branch: "feat/thing", baseBranch: "master",
      sha: SHA_A, sourceWorktreePath: "/tmp/fake-worktree", validationReceipt: { testsPass: true, typecheckPass: true }, submittedByActor: "human:tester",
    });
    const result = await svc.evaluatePublicationAuthorization(candidate.id, "system:evaluator");
    expect(result.state).toBe("publication_authorized");
  });

  it("treats a revoked contract as no match, not a stale authorization", async () => {
    const svc = service();
    const contract = await svc.createRouteContract({
      repo: "acme/widgets", branchPattern: "feat/thing", baseBranch: "master", action: "publish",
      authorizedByUserId: "human:owner",
    });
    await svc.revokeRouteContract(contract.id, "human:owner");
    const candidate = await svc.submitCandidate({
      repo: "acme/widgets", branch: "feat/thing", baseBranch: "master",
      sha: SHA_A, sourceWorktreePath: "/tmp/fake-worktree", validationReceipt: { testsPass: true }, submittedByActor: "human:tester",
    });
    const result = await svc.evaluatePublicationAuthorization(candidate.id, "system:evaluator");
    expect(result.state).toBe("publication_blocked");
  });

  it("treats a tampered contract (content hash no longer matches its stored fields) as blocked, not trusted", async () => {
    const svc = service();
    const contract = await svc.createRouteContract({
      repo: "acme/widgets", branchPattern: "feat/thing", baseBranch: "master", action: "publish",
      authorizedByUserId: "human:owner",
    });
    // Simulate out-of-band tampering: a raw UPDATE bypassing createRouteContract,
    // widening the base branch without updating contentHash to match.
    await db
      .update(deliveryRouteContracts)
      .set({ baseBranch: "main" })
      .where(eq(deliveryRouteContracts.id, contract.id));

    const candidate = await svc.submitCandidate({
      repo: "acme/widgets", branch: "feat/thing", baseBranch: "main",
      sha: SHA_A, sourceWorktreePath: "/tmp/fake-worktree", validationReceipt: { testsPass: true }, submittedByActor: "human:tester",
    });
    const result = await svc.evaluatePublicationAuthorization(candidate.id, "system:evaluator");
    expect(result.state).toBe("publication_blocked");
    expect(result.blockedReason).toMatch(/integrity check/);
  });

  it("is retryable: a blocked candidate can be re-evaluated and authorized once a matching contract is added", async () => {
    const svc = service();
    const candidate = await svc.submitCandidate({
      repo: "acme/widgets", branch: "feat/thing", baseBranch: "master",
      sha: SHA_A, sourceWorktreePath: "/tmp/fake-worktree", validationReceipt: { testsPass: true }, submittedByActor: "human:tester",
    });
    const first = await svc.evaluatePublicationAuthorization(candidate.id, "system:evaluator");
    expect(first.state).toBe("publication_blocked");

    await svc.createRouteContract({
      repo: "acme/widgets", branchPattern: "feat/thing", baseBranch: "master", action: "publish",
      authorizedByUserId: "human:owner",
    });
    const second = await svc.evaluatePublicationAuthorization(candidate.id, "system:evaluator");
    expect(second.state).toBe("publication_authorized");

    const transitions = await svc.listTransitions(candidate.id);
    // submit, blocked, authorized — the blocked attempt stays in history, not overwritten.
    expect(transitions.map((t) => t.toState)).toEqual(
      expect.arrayContaining(["candidate_verified", "publication_blocked", "publication_authorized"]),
    );
  });

  it("refuses to evaluate from a state other than candidate_verified/publication_blocked", async () => {
    const svc = service(undefined, makeFakeGitHubClient({
      findOpenPullRequest: async () => samplePr(),
      readPullRequest: async () => samplePr(),
    }));
    await svc.createRouteContract({
      repo: "acme/widgets", branchPattern: "feat/thing", baseBranch: "master", action: "publish",
      authorizedByUserId: "human:owner",
    });
    const candidate = await svc.submitCandidate({
      repo: "acme/widgets", branch: "feat/thing", baseBranch: "master",
      sha: SHA_A, sourceWorktreePath: "/tmp/fake-worktree", validationReceipt: { testsPass: true }, submittedByActor: "human:tester",
    });
    await svc.evaluatePublicationAuthorization(candidate.id, "system:evaluator");
    const gitClient = makeFakeGitClient({ readRemoteBranchHead: async () => SHA_A });
    const publishSvc = service(gitClient, makeFakeGitHubClient({
      findOpenPullRequest: async () => null,
      createPullRequest: async () => samplePr({ headSha: SHA_A }),
      readPullRequest: async () => samplePr({ headSha: SHA_A }),
    }));
    const published = await publishSvc.publish(candidate.id, "system:publisher");
    expect(published.state).toBe("pr_opened");
    // Now pr_opened — evaluating again must be refused, not silently no-op.
    await expect(publishSvc.evaluatePublicationAuthorization(candidate.id, "system:evaluator")).rejects.toThrow(/Cannot evaluate/);
  });

  // --- publish -------------------------------------------------------------

  async function authorizedCandidate(svcOverride?: ReturnType<typeof service>) {
    const bootstrapSvc = svcOverride ?? service();
    await bootstrapSvc.createRouteContract({
      repo: "acme/widgets", branchPattern: "feat/thing", baseBranch: "master", action: "publish",
      authorizedByUserId: "human:owner",
    });
    const candidate = await bootstrapSvc.submitCandidate({
      repo: "acme/widgets", branch: "feat/thing", baseBranch: "master",
      sha: SHA_A, sourceWorktreePath: "/tmp/fake-worktree", validationReceipt: { testsPass: true }, submittedByActor: "human:tester",
    });
    const authorized = await bootstrapSvc.evaluatePublicationAuthorization(candidate.id, "system:evaluator");
    expect(authorized.state).toBe("publication_authorized");
    return authorized;
  }

  it("refuses to publish from a state other than publication_authorized/publish_failed", async () => {
    const svc = service();
    const candidate = await svc.submitCandidate({
      repo: "acme/widgets", branch: "feat/thing", baseBranch: "master",
      sha: SHA_A, sourceWorktreePath: "/tmp/fake-worktree", validationReceipt: { testsPass: true }, submittedByActor: "human:tester",
    });
    await expect(svc.publish(candidate.id, "system:publisher")).rejects.toThrow(/Cannot publish/);
  });

  it("publishes: push, read-back verify, find-or-create PR, read-back verify, then pr_opened — full evidence recorded", async () => {
    const bootstrap = service();
    const candidate = await authorizedCandidate(bootstrap);

    const gitClient = makeFakeGitClient({ readRemoteBranchHead: async () => SHA_A });
    const githubClient = makeFakeGitHubClient({
      findOpenPullRequest: async () => null,
      createPullRequest: async () => samplePr({ headSha: SHA_A }),
      readPullRequest: async () => samplePr({ headSha: SHA_A }),
    });
    const svc = service(gitClient, githubClient);

    const result = await svc.publish(candidate.id, "system:publisher");
    expect(result.state).toBe("pr_opened");
    expect(result.prNumber).toBe(42);
    expect(result.prUrl).toContain("/pull/42");
    expect(result.remoteBranchVerifiedAt).not.toBeNull();
    expect(result.prVerifiedAt).not.toBeNull();
    // Pushed from the server-owned artifact path (the fake capturer's fixed
    // return value), never the caller-supplied sourceWorktreePath.
    expect(gitClient.pushExactSha).toHaveBeenCalledWith({
      repo: "acme/widgets", sha: SHA_A, branch: "feat/thing", localRepoDir: "/fake/artifact.git",
    });
    expect(githubClient.createPullRequest).toHaveBeenCalledTimes(1);

    const transitions = await svc.listTransitions(candidate.id);
    expect(transitions[0]).toMatchObject({ toState: "pr_opened" });
  });

  it("reuses an already-open PR instead of creating a duplicate (idempotent publish)", async () => {
    const bootstrap = service();
    const candidate = await authorizedCandidate(bootstrap);
    const gitClient = makeFakeGitClient({ readRemoteBranchHead: async () => SHA_A });
    const githubClient = makeFakeGitHubClient({
      findOpenPullRequest: async () => samplePr({ headSha: SHA_A }),
      readPullRequest: async () => samplePr({ headSha: SHA_A }),
    });
    const svc = service(gitClient, githubClient);

    const result = await svc.publish(candidate.id, "system:publisher");
    expect(result.state).toBe("pr_opened");
    expect(githubClient.createPullRequest).not.toHaveBeenCalled();
  });

  it("re-checks contract validity right before publishing (TOCTOU) and blocks — not fails — on a since-revoked contract", async () => {
    const bootstrap = service();
    const candidate = await authorizedCandidate(bootstrap);
    // Revoke the contract in the gap between authorization and publish.
    await db
      .update(deliveryRouteContracts)
      .set({ status: "revoked", revokedByUserId: "human:owner", revokedAt: new Date() })
      .where(eq(deliveryRouteContracts.id, candidate.routeContractId!));

    const gitClient = makeFakeGitClient();
    const svc = service(gitClient);
    const result = await svc.publish(candidate.id, "system:publisher");
    expect(result.state).toBe("publication_blocked");
    expect(result.blockedReason).toMatch(/revoked before this claim/);
    // Never touched git at all — the block happens before any push attempt.
    expect(gitClient.pushExactSha).not.toHaveBeenCalled();
  });

  it("marks publish_failed (not pr_opened) when the push itself throws, and the failure is retryable", async () => {
    const bootstrap = service();
    const candidate = await authorizedCandidate(bootstrap);
    const gitClient = makeFakeGitClient({
      pushExactSha: async () => { throw new Error("remote rejected non-fast-forward"); },
    });
    const svc = service(gitClient);
    const failed = await svc.publish(candidate.id, "system:publisher");
    expect(failed.state).toBe("publish_failed");
    expect(failed.blockedReason).toContain("remote rejected non-fast-forward");

    // Retry with a working client succeeds from publish_failed.
    const workingGit = makeFakeGitClient({ readRemoteBranchHead: async () => SHA_A });
    const workingGithub = makeFakeGitHubClient({
      findOpenPullRequest: async () => null,
      createPullRequest: async () => samplePr({ headSha: SHA_A }),
      readPullRequest: async () => samplePr({ headSha: SHA_A }),
    });
    const retrySvc = service(workingGit, workingGithub);
    const retried = await retrySvc.publish(candidate.id, "system:publisher");
    expect(retried.state).toBe("pr_opened");
  });

  it("marks publish_failed when the pushed SHA doesn't match what the remote branch actually reports back", async () => {
    const bootstrap = service();
    const candidate = await authorizedCandidate(bootstrap);
    const gitClient = makeFakeGitClient({ readRemoteBranchHead: async () => SHA_B }); // wrong sha
    const svc = service(gitClient);
    const result = await svc.publish(candidate.id, "system:publisher");
    expect(result.state).toBe("publish_failed");
    expect(result.blockedReason).toMatch(/does not match/);
  });

  it("marks publish_failed when PR creation throws", async () => {
    const bootstrap = service();
    const candidate = await authorizedCandidate(bootstrap);
    const gitClient = makeFakeGitClient({ readRemoteBranchHead: async () => SHA_A });
    const githubClient = makeFakeGitHubClient({
      findOpenPullRequest: async () => null,
      createPullRequest: async () => { throw new Error("422 validation failed"); },
    });
    const svc = service(gitClient, githubClient);
    const result = await svc.publish(candidate.id, "system:publisher");
    expect(result.state).toBe("publish_failed");
    expect(result.blockedReason).toContain("422 validation failed");
  });

  it("marks publish_failed when the PR read-back verification doesn't match (head SHA mismatch)", async () => {
    const bootstrap = service();
    const candidate = await authorizedCandidate(bootstrap);
    const gitClient = makeFakeGitClient({ readRemoteBranchHead: async () => SHA_A });
    const githubClient = makeFakeGitHubClient({
      findOpenPullRequest: async () => null,
      createPullRequest: async () => samplePr({ headSha: SHA_A }),
      readPullRequest: async () => samplePr({ headSha: SHA_B }), // read-back disagrees
    });
    const svc = service(gitClient, githubClient);
    const result = await svc.publish(candidate.id, "system:publisher");
    expect(result.state).toBe("publish_failed");
    expect(result.blockedReason).toMatch(/read-back verification failed/);
  });

  // --- claimForPublish (isolated from the full publish() execution path) --

  it("claimForPublish alone moves an authorized candidate to publishing and stops there — no git/GitHub call happens", async () => {
    const bootstrap = service();
    const candidate = await authorizedCandidate(bootstrap);
    const gitClient = makeFakeGitClient();
    const githubClient = makeFakeGitHubClient();
    const svc = service(gitClient, githubClient);

    const claim = await svc.claimForPublish(candidate.id, "system:publisher");
    expect(claim.kind).toBe("claimed");
    expect(claim.candidate.state).toBe("publishing");
    expect(gitClient.pushExactSha).not.toHaveBeenCalled();
    expect(githubClient.createPullRequest).not.toHaveBeenCalled();

    const transitions = await svc.listTransitions(candidate.id);
    expect(transitions[0]).toMatchObject({ fromState: "publication_authorized", toState: "publishing" });
  });

  it("a second claimForPublish on a candidate already in publishing is refused, not silently accepted", async () => {
    const bootstrap = service();
    const candidate = await authorizedCandidate(bootstrap);
    const svc = service();
    const first = await svc.claimForPublish(candidate.id, "system:publisher-a");
    expect(first.kind).toBe("claimed");

    await expect(svc.claimForPublish(candidate.id, "system:publisher-b")).rejects.toThrow(/Cannot publish from state "publishing"/);
  });

  // --- describeNextAction ---------------------------------------------------

  it("describeNextAction names one owner and one action per state, including a human-facing reason when blocked", () => {
    expect(describeNextAction({ state: "candidate_verified", blockedReason: null })).toMatchObject({ owner: "system" });
    expect(describeNextAction({ state: "publication_blocked", blockedReason: "no contract" })).toEqual({
      owner: "human", action: "no contract",
    });
    expect(describeNextAction({ state: "publication_authorized", blockedReason: null })).toMatchObject({ owner: "system" });
    expect(describeNextAction({ state: "publishing", blockedReason: null })).toMatchObject({ owner: "system" });
    expect(describeNextAction({ state: "pr_opened", blockedReason: null })).toMatchObject({ owner: "human" });
    expect(describeNextAction({ state: "merge_authorized", blockedReason: null })).toEqual({
      owner: "human", action: "not yet automated by this controller version",
    });
    expect(describeNextAction({ state: "accepted", blockedReason: null })).toMatchObject({ owner: "none" });
  });
});
