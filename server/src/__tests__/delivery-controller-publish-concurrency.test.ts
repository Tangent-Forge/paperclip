import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, deliveryCandidates, deliveryRouteContracts, deliveryTransitions } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { deliveryControllerRoutes } from "../routes/delivery-controller.js";
import type { DeliveryGitClient, DeliveryGitHubClient, PullRequestInfo } from "../services/delivery-controller.ts";
import type { DeliverySourceArtifactCapturer } from "../services/delivery-source-artifact.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping delivery-controller publish-concurrency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Proves the transactional publish claim/lease at the level it actually
// matters: real concurrent HTTP requests against a real Express route,
// backed by real embedded Postgres — not a direct call to claimForPublish().
// Every git/GitHub call is a fake (never a real remote), but the fakes are
// shared, instrumented spies visible to every concurrent request, so the
// assertion "exactly one push and one PR-create attempt happened" is a real
// count across genuinely racing HTTP calls, not an assumption.
describeEmbeddedPostgres("delivery controller — publish claim under concurrent HTTP requests", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-delivery-controller-publish-concurrency-");
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

  const BOARD = { type: "board" as const, userId: "user-1", isInstanceAdmin: false };
  const INSTANCE_ADMIN = { type: "board" as const, userId: "admin-1", isInstanceAdmin: true };

  function createApp(
    actor: { type: "board" | "agent" | "none"; userId?: string; isInstanceAdmin?: boolean },
    gitClient: DeliveryGitClient,
    githubClient: DeliveryGitHubClient,
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: typeof actor }).actor = actor;
      next();
    });
    const sourceArtifact: DeliverySourceArtifactCapturer = {
      captureArtifact: async () => ({ artifactPath: "/fake/artifact.git", capturedAt: new Date() }),
    };
    app.use("/api", deliveryControllerRoutes(db, { gitClient, githubClient, sourceArtifact }));
    app.use(errorHandler);
    return app;
  }

  it("under N simultaneous publish requests for the same candidate, exactly one push and one PR-create attempt happen, and exactly one request receives pr_opened", async () => {
    const REQUEST_COUNT = 10;

    // Seed: an active route contract, and a candidate already evaluated to
    // publication_authorized, via the real routes (not direct service
    // calls), matching how a real caller would get here.
    const adminApp = createApp(INSTANCE_ADMIN, {} as DeliveryGitClient, {} as DeliveryGitHubClient);
    await request(adminApp)
      .post("/api/delivery-route-contracts")
      .send({ repo: "acme/widgets", branchPattern: "feat/thing", baseBranch: "master", action: "publish" });

    const gitClient: DeliveryGitClient = {
      pushExactSha: vi.fn(async () => {}),
      readRemoteBranchHead: vi.fn(async () => "a".repeat(40)),
    };
    let prCounter = 0;
    const sampleUrl = (n: number) => `https://github.com/acme/widgets/pull/${n}`;
    const githubClient: DeliveryGitHubClient = {
      findOpenPullRequest: vi.fn(async () => null),
      createPullRequest: vi.fn(async () => {
        prCounter += 1;
        return { number: prCounter, url: sampleUrl(prCounter), headSha: "a".repeat(40), baseBranch: "master", state: "open" } satisfies PullRequestInfo;
      }),
      readPullRequest: vi.fn(async () => ({ number: prCounter, url: sampleUrl(prCounter), headSha: "a".repeat(40), baseBranch: "master", state: "open" }) satisfies PullRequestInfo),
    };
    const boardApp = createApp(BOARD, gitClient, githubClient);

    const submitted = await request(boardApp).post("/api/delivery-candidates").send({
      repo: "acme/widgets", branch: "feat/thing", baseBranch: "master",
      sha: "a".repeat(40), sourceWorktreePath: "/tmp/x", validationReceipt: { testsPass: true },
    });
    const candidateId = submitted.body.id as string;
    const evaluated = await request(boardApp).post(`/api/delivery-candidates/${candidateId}/evaluate`).send();
    expect(evaluated.body.state).toBe("publication_authorized");

    // The actual race: REQUEST_COUNT simultaneous publish attempts on the
    // SAME candidate, sharing the SAME gitClient/githubClient spies — so
    // call counts below reflect the true total across every concurrent
    // request, not one app's private view.
    const responses = await Promise.all(
      Array.from({ length: REQUEST_COUNT }, () =>
        request(boardApp).post(`/api/delivery-candidates/${candidateId}/publish`).send()),
    );

    const succeeded = responses.filter((r) => r.status === 200 && r.body.state === "pr_opened");
    const conflicted = responses.filter((r) => r.status === 409);

    expect(succeeded).toHaveLength(1);
    expect(conflicted).toHaveLength(REQUEST_COUNT - 1);
    expect(responses).toHaveLength(REQUEST_COUNT); // no response was anything other than 200/409

    // The actual claim: exactly one push, exactly one PR-create attempt —
    // never REQUEST_COUNT of either, regardless of how many requests raced.
    expect(gitClient.pushExactSha).toHaveBeenCalledTimes(1);
    expect(githubClient.createPullRequest).toHaveBeenCalledTimes(1);

    // Truthful, not just numerically single: exactly one real heartbeat-style
    // record exists, and it's the one the succeeding response named.
    const finalCandidate = await db.select().from(deliveryCandidates).where(eq(deliveryCandidates.id, candidateId));
    expect(finalCandidate).toHaveLength(1);
    expect(finalCandidate[0]?.state).toBe("pr_opened");
    expect(finalCandidate[0]?.prNumber).toBe(succeeded[0]?.body.prNumber);

    // The transition log shows exactly one "publishing" claim, not
    // REQUEST_COUNT of them — the conflicted requests never got far enough
    // to record one; transitionCandidate() refuses before the log write.
    const publishingTransitions = await db
      .select()
      .from(deliveryTransitions)
      .where(eq(deliveryTransitions.candidateId, candidateId));
    expect(publishingTransitions.filter((t) => t.toState === "publishing")).toHaveLength(1);
    expect(publishingTransitions.filter((t) => t.toState === "pr_opened")).toHaveLength(1);
  });
});
