import express from "express";
import { EventEmitter } from "node:events";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetExperimental = vi.hoisted(() => vi.fn());
const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  addComment: vi.fn(),
  listComments: vi.fn(),
}));
const mockSpawn = vi.hoisted(() => vi.fn());
const mockAssertInstanceAdmin = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getExperimental: mockGetExperimental }),
  issueService: () => mockIssueService,
}));

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

vi.mock("../routes/authz.js", () => ({
  getActorInfo: () => ({ actorId: "user-1", agentId: null, runId: null }),
  assertCompanyAccess: () => {},
  assertInstanceAdmin: mockAssertInstanceAdmin,
}));

async function createApp(opts?: {
  deploymentMode?: "local_trusted" | "authenticated";
  deploymentExposure?: "private" | "public";
  bindHost?: string;
}) {
  const { boardChatRoutes } = await import("../routes/board-chat.js");
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    boardChatRoutes({} as any, {
      deploymentMode: opts?.deploymentMode ?? "local_trusted",
      deploymentExposure: opts?.deploymentExposure ?? "private",
      bindHost: opts?.bindHost ?? "127.0.0.1",
    }),
  );
  // Minimal stand-in for the real errorHandler middleware: surfaces the
  // status of HttpErrors thrown by authz assertions instead of Express's
  // default 500.
  app.use(
    (
      err: Error & { status?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(err.status ?? 500).json({ error: err.message });
    },
  );
  return app;
}

describe("POST /api/board/chat/stream feature flag guard (PAP-137)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 FEATURE_DISABLED when enableConferenceRoomChat is off", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: false });
    const app = await createApp();

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "Conference Room Chat is not enabled",
      code: "FEATURE_DISABLED",
    });
    // The guard must fire before anything is persisted.
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("lets requests past the guard when the flag is on (400 on missing body, not 403)", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    const app = await createApp();

    // Omit the body so the request stops at validation — proves the guard
    // admitted it without spawning the chat subprocess.
    const res = await request(app).post("/api/board/chat/stream").send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "companyId and message are required" });
  });
});

describe("POST /api/board/chat/stream deployment guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
  });

  it("admits local_trusted without consulting the instance-admin assertion", async () => {
    const app = await createApp({ deploymentMode: "local_trusted" });

    const res = await request(app).post("/api/board/chat/stream").send({});

    // 400 (body validation) proves the guard admitted the request.
    expect(res.status).toBe(400);
    expect(mockAssertInstanceAdmin).not.toHaveBeenCalled();
  });

  it("admits authenticated + private + loopback when the actor is an instance admin", async () => {
    const app = await createApp({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
    });

    const res = await request(app).post("/api/board/chat/stream").send({});

    expect(res.status).toBe(400);
    expect(mockAssertInstanceAdmin).toHaveBeenCalledTimes(1);
  });

  it("returns 403 on authenticated + private + loopback when the actor is not an instance admin", async () => {
    mockAssertInstanceAdmin.mockImplementationOnce(() => {
      throw Object.assign(new Error("Instance admin access required"), { status: 403 });
    });
    const app = await createApp({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
    });

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Instance admin access required");
    // Denied before anything is persisted or spawned.
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockIssueService.create).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it.each([
    // Public exposure is refused even loopback-bound: the mode/exposure/bind
    // gate fires before the actor is ever consulted.
    { deploymentExposure: "public" as const, bindHost: "127.0.0.1" },
    // Non-loopback binds are refused even with private exposure.
    { deploymentExposure: "private" as const, bindHost: "0.0.0.0" },
    { deploymentExposure: "private" as const, bindHost: "192.168.1.10" },
    { deploymentExposure: "public" as const, bindHost: "0.0.0.0" },
  ])(
    "returns 403 DEPLOYMENT_MODE_UNSUPPORTED for authenticated + $deploymentExposure + $bindHost",
    async ({ deploymentExposure, bindHost }) => {
      const app = await createApp({
        deploymentMode: "authenticated",
        deploymentExposure,
        bindHost,
      });

      const res = await request(app)
        .post("/api/board/chat/stream")
        .send({ companyId: "company-1", message: "hello" });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("DEPLOYMENT_MODE_UNSUPPORTED");
      // An admin actor cannot rescue an unsupported network posture.
      expect(mockAssertInstanceAdmin).not.toHaveBeenCalled();
      expect(mockIssueService.addComment).not.toHaveBeenCalled();
    },
  );

  it("accepts localhost and ::1 as loopback binds", async () => {
    for (const bindHost of ["localhost", "::1"]) {
      const app = await createApp({
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        bindHost,
      });
      const res = await request(app).post("/api/board/chat/stream").send({});
      expect(res.status).toBe(400);
    }
    expect(mockAssertInstanceAdmin).toHaveBeenCalledTimes(2);
  });
});

describe("board-chat client disconnect", () => {
  function makeFakeProc() {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.exitCode = null;
    proc.killed = false;
    proc.kill = vi.fn(() => {
      proc.killed = true;
    });
    return proc;
  }

  it("kills the spawned subprocess when the client disconnects mid-stream", async () => {
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    mockIssueService.list.mockResolvedValue([
      { id: "issue-1", title: "Board Operations", status: "todo" },
    ]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1" });
    mockIssueService.listComments.mockResolvedValue([]);
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc);
    const app = await createApp();

    const req = request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });
    // Start the request without awaiting the (never-ending) SSE response.
    const pending = req.then(
      () => undefined,
      () => undefined,
    );

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    expect(fakeProc.kill).not.toHaveBeenCalled();

    // Client walks away mid-stream.
    req.abort();
    await vi.waitFor(() => expect(fakeProc.kill).toHaveBeenCalledWith("SIGTERM"));

    // Let the subprocess close handler run so the slot is released.
    fakeProc.exitCode = 143;
    fakeProc.emit("close", 143);
    await pending;
  });
});

describe("board-chat history role classification", () => {
  it("treats only board-concierge comments as assistant turns", async () => {
    const { isConciergeReply } = await import("../routes/board-chat.js");

    // The relay's own persisted replies.
    expect(
      isConciergeReply({ authorAgentId: null, authorUserId: "board-concierge" }),
    ).toBe(true);

    // A human board user.
    expect(isConciergeReply({ authorAgentId: null, authorUserId: "user-1" })).toBe(
      false,
    );

    // An agent commenting on the standing issue is NOT this assistant — its
    // words must not be serialized as the assistant's own prior turns.
    expect(
      isConciergeReply({ authorAgentId: "agent-1", authorUserId: null }),
    ).toBe(false);

    // Defensive: an agent comment can never impersonate the concierge even if
    // both author fields are somehow set.
    expect(
      isConciergeReply({ authorAgentId: "agent-1", authorUserId: "board-concierge" }),
    ).toBe(false);
  });
});
