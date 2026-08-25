import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, deliveryCandidates, deliveryRouteContracts, deliveryTransitions } from "@paperclipai/db";
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
import type { DeliverySourceArtifactCapturer } from "../services/delivery-source-artifact.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping delivery-controller lease-fencing tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA_A = "a".repeat(40);

function makeFakeGitClient(overrides: Partial<DeliveryGitClient> = {}): DeliveryGitClient & Record<string, ReturnType<typeof vi.fn>> {
  return {
    pushExactSha: vi.fn(overrides.pushExactSha ?? (async () => {})),
    readRemoteBranchHead: vi.fn(overrides.readRemoteBranchHead ?? (async () => SHA_A)),
  } as never;
}
function makeFakeSourceArtifact(): DeliverySourceArtifactCapturer {
  return { captureArtifact: async () => ({ artifactPath: "/fake/artifact.git", capturedAt: new Date() }) };
}

// The exact race the owner named: "A slow original publisher can outlive its
// five-minute lease, then overwrite the reconciler's result because final
// transitions are guarded only by state = publishing, not by its specific
// attempt ID." reconcileExpiredLease()'s reclaim is a publishing ->
// publishing SELF-LOOP — it does not change `state` — so a stale attempt
// that already got reclaimed can still observe state = "publishing" for the
// rest of its own execution and reach its own final transition believing
// it's still authoritative. This file constructs that exact ordering with
// NO real concurrency/timing tricks — every step is awaited in a chosen
// sequence — and proves runPublishExecution()'s leaseAttemptId fence (not
// just the base state guard) is what stops the stale attempt from winning.
describeEmbeddedPostgres("delivery controller — lease attempt-id fencing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-delivery-controller-fencing-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(deliveryTransitions);
    await db.delete(deliveryCandidates);
    await db.delete(deliveryRouteContracts);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function service(deps: Partial<DeliveryControllerDeps> = {}) {
    return deliveryControllerService(db, {
      gitClient: deps.gitClient ?? makeFakeGitClient(),
      githubClient: deps.githubClient ?? {
        findOpenPullRequest: vi.fn(async () => null),
        createPullRequest: vi.fn(async () => { throw new Error("createPullRequest not configured for this test"); }),
        readPullRequest: vi.fn(async () => null),
      },
      sourceArtifact: deps.sourceArtifact ?? makeFakeSourceArtifact(),
    });
  }

  it("a stale (reclaimed-away) attempt cannot finalize over the reconciler that reclaimed it, even though state alone never changed", async () => {
    const bootstrap = service();
    await bootstrap.createRouteContract({
      repo: "acme/widgets", branchPattern: "feat/thing", baseBranch: "master", action: "publish",
      authorizedByUserId: "human:owner",
    });
    const candidate = await bootstrap.submitCandidate({
      repo: "acme/widgets", branch: "feat/thing", baseBranch: "master", sha: SHA_A,
      sourceWorktreePath: "/tmp/x", validationReceipt: { testsPass: true }, submittedByActor: "human:tester",
    });
    await bootstrap.evaluatePublicationAuthorization(candidate.id, "system:evaluator");

    // Set up the scenario directly: candidate already "publishing" under
    // attempt A, lease long expired (as if the original crashed/stalled).
    const attemptA = randomUUID();
    await db
      .update(deliveryCandidates)
      .set({ state: "publishing", leaseAttemptId: attemptA, leaseExpiresAt: new Date(Date.now() - 1000), leaseOwner: "worker:original" })
      .where(eq(deliveryCandidates.id, candidate.id));

    // Step 1 — the reconciler's RECLAIM, done directly rather than via the
    // real reconcileExpiredLease() (which reclaims AND runs the full
    // execution in one call — too coarse to interleave with the stale
    // original's own in-flight execution below). This update is exactly
    // what reconcileExpiredLease()'s own transitionCandidate call does: a
    // publishing -> publishing self-loop that changes ONLY the lease fields
    // (a fresh attempt B), never `state`. That is the fait accompli that
    // makes the row's real leaseAttemptId "B" from this point on, while the
    // original's in-memory candidate object below still (correctly, at the
    // time it read it) says "A".
    const attemptB = randomUUID();
    const [reconciled] = await db
      .update(deliveryCandidates)
      .set({ leaseAttemptId: attemptB, leaseExpiresAt: new Date(Date.now() + 5 * 60_000), leaseOwner: "worker:reconciler" })
      .where(eq(deliveryCandidates.id, candidate.id))
      .returning();
    expect(reconciled).toBeTruthy();
    expect(attemptB).not.toBe(attemptA);
    expect(reconciled!.state).toBe("publishing"); // reclaim alone never advances state

    // A single, STATEFUL shared "GitHub" is used by both sides below — real
    // GitHub state does not fork just because two local processes are
    // racing over it; once one side creates the PR, the other side's own
    // findOpenPullRequest must see it (this is what makes the existing
    // idempotent find-before-create logic actually kick in here, same as
    // it would against a real remote).
    let existingPr: PullRequestInfo | null = null;
    const githubClient = {
      findOpenPullRequest: vi.fn(async () => existingPr),
      createPullRequest: vi.fn(async (): Promise<PullRequestInfo> => {
        existingPr = { number: 7, url: "https://github.com/acme/widgets/pull/7", headSha: SHA_A, baseBranch: "master", state: "open" };
        return existingPr;
      }),
      readPullRequest: vi.fn(async (): Promise<PullRequestInfo> => existingPr ?? {
        number: 7, url: "https://github.com/acme/widgets/pull/7", headSha: SHA_A, baseBranch: "master", state: "open",
      }),
    } satisfies DeliveryGitHubClient;
    const gitClient = makeFakeGitClient();
    const svc = service({ gitClient, githubClient });

    // Step 2 — the STALE original, holding the row snapshot from BEFORE the
    // reconciler reclaimed (attemptId still "A", state still "publishing" —
    // exactly what it would have had in memory the whole time it was
    // "slow"), now runs its own full execution and reaches its own final
    // transition. Deliberately calling the exported runPublishExecution()
    // directly — this is precisely what a slow original's in-flight call
    // would do internally; there is no other way to construct this ordering
    // deterministically without real timing races.
    const staleOriginalSnapshot = { ...candidate, state: "publishing", leaseAttemptId: attemptA, leaseExpiresAt: new Date(Date.now() - 1000), leaseOwner: "worker:original", failureCount: 0 } as typeof candidate;
    const staleResult = await svc.runPublishExecution(staleOriginalSnapshot, "worker:original");

    // The stale attempt must NOT have finalized to pr_opened — its own
    // finalize call should have been refused (leaseAttemptId no longer
    // matches "A") and it should have adopted whatever the row actually
    // holds instead.
    expect(staleResult.state).not.toBe("pr_opened");
    expect(staleResult.leaseAttemptId).toBe(attemptB); // NOT overwritten back to A

    // Step 3 — the reconciler (attempt B) now finishes its OWN execution.
    // Its push/PR-create is idempotent against whatever the stale original
    // already did against "GitHub" (the shared fake), so this either finds
    // or creates the PR — but its finalize, guarded by attemptId = B,
    // legitimately succeeds.
    const finalResult = await svc.runPublishExecution(reconciled!, "worker:reconciler");
    expect(finalResult.state).toBe("pr_opened");
    expect(finalResult.leaseAttemptId).toBe(attemptB);
    expect(finalResult.prNumber).toBe(7);

    // No duplicate PR, regardless of which side actually ran the push/find-
    // or-create steps first — the idempotent find-before-create still holds
    // even under this exact race.
    expect(githubClient.createPullRequest).toHaveBeenCalledTimes(1);

    // The durable transition log's terminal entry is authored by the
    // reconciler, not the superseded original — the append-only history
    // itself reflects who actually won, not just the final row.
    const transitions = await db
      .select()
      .from(deliveryTransitions)
      .where(eq(deliveryTransitions.candidateId, candidate.id));
    const finalTransition = transitions.filter((t) => t.toState === "pr_opened");
    expect(finalTransition).toHaveLength(1);
    expect(finalTransition[0]?.actor).toBe("worker:reconciler");
  });
});
