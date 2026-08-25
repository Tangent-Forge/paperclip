import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, deliveryCandidates, deliveryRouteContracts, deliveryTransitions, deliveryWorkerActivations } from "@paperclipai/db";
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
    `Skipping delivery-controller route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function samplePr(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    number: 12, url: "https://github.com/acme/widgets/pull/12",
    headSha: "a".repeat(40), baseBranch: "master", state: "open",
    ...overrides,
  };
}

function makeFakeGitClient(overrides: Partial<DeliveryGitClient> = {}): DeliveryGitClient & Record<string, ReturnType<typeof vi.fn>> {
  return {
    pushExactSha: vi.fn(overrides.pushExactSha ?? (async () => {})),
    readRemoteBranchHead: vi.fn(overrides.readRemoteBranchHead ?? (async () => "a".repeat(40))),
  } as never;
}
function makeFakeGitHubClient(overrides: Partial<DeliveryGitHubClient> = {}): DeliveryGitHubClient & Record<string, ReturnType<typeof vi.fn>> {
  return {
    findOpenPullRequest: vi.fn(overrides.findOpenPullRequest ?? (async () => null)),
    createPullRequest: vi.fn(overrides.createPullRequest ?? (async () => samplePr())),
    readPullRequest: vi.fn(overrides.readPullRequest ?? (async () => samplePr())),
  } as never;
}

// Proves the AUTHENTICATED HTTP SURFACE — real Express routes, real
// supertest requests, real embedded Postgres — not the service functions
// directly. Every git/GitHub call is a fake; no real remote is ever touched
// here (or anywhere in this session).
describeEmbeddedPostgres("delivery controller — authenticated HTTP surface", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-delivery-controller-routes-");
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

  function createApp(
    actor: { type: "board" | "agent" | "none"; userId?: string; isInstanceAdmin?: boolean },
    gitClient?: DeliveryGitClient,
    githubClient?: DeliveryGitHubClient,
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: typeof actor }).actor = actor;
      next();
    });
    const fakeSourceArtifact: DeliverySourceArtifactCapturer = {
      captureArtifact: async () => ({ artifactPath: "/fake/artifact.git", capturedAt: new Date() }),
    };
    app.use(
      "/api",
      deliveryControllerRoutes(db, {
        gitClient: gitClient ?? makeFakeGitClient(),
        githubClient: githubClient ?? makeFakeGitHubClient(),
        sourceArtifact: fakeSourceArtifact,
      }),
    );
    app.use(errorHandler);
    return app;
  }

  const BOARD = { type: "board" as const, userId: "user-1", isInstanceAdmin: false };
  const INSTANCE_ADMIN = { type: "board" as const, userId: "admin-1", isInstanceAdmin: true };
  const AGENT = { type: "agent" as const };

  it("only instance-admin board actors may create a route contract — plain board and agent actors are refused", async () => {
    const contractInput = { repo: "acme/widgets", branchPattern: "feat/thing", baseBranch: "master", action: "publish" };

    const asBoard = await request(createApp(BOARD)).post("/api/delivery-route-contracts").send(contractInput);
    expect(asBoard.status).toBe(403);

    const asAgent = await request(createApp(AGENT)).post("/api/delivery-route-contracts").send(contractInput);
    expect(asAgent.status).toBe(403);

    const asAdmin = await request(createApp(INSTANCE_ADMIN)).post("/api/delivery-route-contracts").send(contractInput);
    expect(asAdmin.status).toBe(201);
    expect(asAdmin.body.authorizedByUserId).toBe("admin-1");

    const rows = await db.select().from(deliveryRouteContracts);
    expect(rows).toHaveLength(1); // the two refused attempts created nothing
  });

  it("only instance-admin board actors may revoke a route contract", async () => {
    const created = await request(createApp(INSTANCE_ADMIN))
      .post("/api/delivery-route-contracts")
      .send({ repo: "acme/widgets", branchPattern: "feat/thing", baseBranch: "master", action: "publish" });
    const contractId = created.body.id as string;

    const asBoard = await request(createApp(BOARD)).post(`/api/delivery-route-contracts/${contractId}/revoke`).send();
    expect(asBoard.status).toBe(403);

    const asAdmin = await request(createApp(INSTANCE_ADMIN)).post(`/api/delivery-route-contracts/${contractId}/revoke`).send();
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.status).toBe("revoked");
    expect(asAdmin.body.revokedByUserId).toBe("admin-1");
  });

  it("candidate submission requires board access — an agent actor is refused", async () => {
    const input = {
      repo: "acme/widgets", branch: "feat/thing", baseBranch: "master",
      sha: "a".repeat(40), sourceWorktreePath: "/tmp/x", validationReceipt: { testsPass: true },
    };
    const asAgent = await request(createApp(AGENT)).post("/api/delivery-candidates").send(input);
    expect(asAgent.status).toBe(403);

    const asBoard = await request(createApp(BOARD)).post("/api/delivery-candidates").send(input);
    expect(asBoard.status).toBe(201);
    expect(asBoard.body.submittedByActor).toBe("board:user-1");
  });

  it("every mutation is durably logged with the real actor identity — submit, evaluate, and publish each leave a transition row", async () => {
    await request(createApp(INSTANCE_ADMIN))
      .post("/api/delivery-route-contracts")
      .send({ repo: "acme/widgets", branchPattern: "feat/thing", baseBranch: "master", action: "publish" });

    const submitted = await request(createApp(BOARD)).post("/api/delivery-candidates").send({
      repo: "acme/widgets", branch: "feat/thing", baseBranch: "master",
      sha: "a".repeat(40), sourceWorktreePath: "/tmp/x", validationReceipt: { testsPass: true },
    });
    const candidateId = submitted.body.id as string;

    const evaluated = await request(createApp(BOARD)).post(`/api/delivery-candidates/${candidateId}/evaluate`).send();
    expect(evaluated.body.state).toBe("publication_authorized");

    const gitClient = makeFakeGitClient();
    const githubClient = makeFakeGitHubClient();
    const published = await request(createApp(BOARD, gitClient, githubClient))
      .post(`/api/delivery-candidates/${candidateId}/publish`)
      .send();
    expect(published.body.state).toBe("pr_opened");

    const transitions = await db
      .select()
      .from(deliveryTransitions)
      .where(eq(deliveryTransitions.candidateId, candidateId));
    const byToState = new Map(transitions.map((t) => [t.toState, t]));
    expect(byToState.get("candidate_verified")).toMatchObject({ actor: "board:user-1" });
    expect(byToState.get("publication_authorized")).toMatchObject({ actor: "board:user-1" });
    expect(byToState.get("publishing")).toMatchObject({ actor: "board:user-1" });
    expect(byToState.get("pr_opened")).toMatchObject({ actor: "board:user-1" });
  });

  it("GET a candidate returns its next action and full transition history", async () => {
    const submitted = await request(createApp(BOARD)).post("/api/delivery-candidates").send({
      repo: "acme/widgets", branch: "feat/thing", baseBranch: "master",
      sha: "b".repeat(40), sourceWorktreePath: "/tmp/x", validationReceipt: { testsPass: true },
    });
    const candidateId = submitted.body.id as string;

    const fetched = await request(createApp(BOARD)).get(`/api/delivery-candidates/${candidateId}`).send();
    expect(fetched.status).toBe(200);
    expect(fetched.body.nextAction).toEqual({
      owner: "system", action: "evaluate publication authorization against the matching route contract",
    });
    expect(fetched.body.transitions).toHaveLength(1);
  });

  it("GET the candidate list supports filtering by state", async () => {
    await request(createApp(BOARD)).post("/api/delivery-candidates").send({
      repo: "acme/widgets", branch: "feat/a", baseBranch: "master",
      sha: "c".repeat(40), sourceWorktreePath: "/tmp/x", validationReceipt: { testsPass: true },
    });
    const listed = await request(createApp(BOARD)).get("/api/delivery-candidates?state=candidate_verified").send();
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].nextAction.owner).toBe("system");
  });

  it("a route contract accepts an explicit autoRetryLimit/retryBackoffSeconds and defaults them when omitted", async () => {
    const withOverrides = await request(createApp(INSTANCE_ADMIN)).post("/api/delivery-route-contracts").send({
      repo: "acme/widgets", branchPattern: "feat/a", baseBranch: "master", action: "publish",
      autoRetryLimit: 5, retryBackoffSeconds: 120,
    });
    expect(withOverrides.status).toBe(201);
    expect(withOverrides.body.autoRetryLimit).toBe(5);
    expect(withOverrides.body.retryBackoffSeconds).toBe(120);

    const withDefaults = await request(createApp(INSTANCE_ADMIN)).post("/api/delivery-route-contracts").send({
      repo: "acme/widgets", branchPattern: "feat/b", baseBranch: "master", action: "publish",
    });
    expect(withDefaults.body.autoRetryLimit).toBe(0);
    expect(withDefaults.body.retryBackoffSeconds).toBe(60);
  });

  // Same authority tier as route contracts — this is what actually lets a
  // deployed scheduler start touching git/GitHub unattended, so it gets the
  // same assertInstanceAdmin split, proven the same way.
  it("only instance-admin board actors may activate or deactivate the delivery worker — a plain board actor can only read status", async () => {
    const asBoard = await request(createApp(BOARD)).post("/api/delivery-worker-activation").send({ reason: "go-live" });
    expect(asBoard.status).toBe(403);

    const asAgent = await request(createApp(AGENT)).post("/api/delivery-worker-activation").send({});
    expect(asAgent.status).toBe(403);

    const statusBefore = await request(createApp(BOARD)).get("/api/delivery-worker-activation").send();
    expect(statusBefore.status).toBe(200);
    expect(statusBefore.body.activated).toBe(false);

    const asAdmin = await request(createApp(INSTANCE_ADMIN)).post("/api/delivery-worker-activation").send({ reason: "go-live" });
    expect(asAdmin.status).toBe(201);
    expect(asAdmin.body.authorizedByUserId).toBe("admin-1");
    expect(asAdmin.body.reason).toBe("go-live");

    const statusAfter = await request(createApp(BOARD)).get("/api/delivery-worker-activation").send();
    expect(statusAfter.body.activated).toBe(true);

    const deactivateAsBoard = await request(createApp(BOARD)).post("/api/delivery-worker-activation/deactivate").send();
    expect(deactivateAsBoard.status).toBe(403);

    const deactivateAsAdmin = await request(createApp(INSTANCE_ADMIN)).post("/api/delivery-worker-activation/deactivate").send();
    expect(deactivateAsAdmin.status).toBe(200);
    expect(deactivateAsAdmin.body.revoked).toHaveLength(1);
    expect(deactivateAsAdmin.body.revoked[0].revokedByUserId).toBe("admin-1");

    const statusFinal = await request(createApp(BOARD)).get("/api/delivery-worker-activation").send();
    expect(statusFinal.body.activated).toBe(false);
  });
});
