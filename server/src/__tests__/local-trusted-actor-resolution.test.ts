import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";

// PAP-1975 regression coverage. Before this fix, `deploymentMode: "local_trusted"`
// unconditionally assigned every request with no Authorization header full
// board + instance-admin identity as `local-board` — indistinguishable from a
// genuine operator action in the activity log, and reachable by any
// shell-capable agent hitting the loopback API directly (verified in the wild
// 2026-07-31 and again 2026-08-17). These tests assert the fail-closed
// replacement: anonymous loopback traffic resolves to `type: "none"`, and
// real credentials (agent API key) still resolve to their own identity,
// unaffected by deploymentMode.
//
// Bearer-token resolution order in actorMiddleware, reflected in the mock
// `select` call sequence below: (1) board key lookup via
// boardAuth.findBoardApiKeyByToken, (2) agentApiKeys lookup, (3) agents lookup.

function createSelectChain(rows: unknown[]) {
  return {
    from() {
      return {
        where() {
          return Promise.resolve(rows);
        },
      };
    },
  };
}

function createUpdateChain() {
  return {
    set() {
      return {
        where() {
          return Promise.resolve();
        },
      };
    },
  };
}

function buildApp(deploymentMode: "local_trusted" | "authenticated", db: any) {
  const app = express();
  app.use(actorMiddleware(db, { deploymentMode }));
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  return app;
}

describe("PAP-1975: local_trusted actor resolution", () => {
  it("does NOT grant board/instance-admin to an anonymous loopback request", async () => {
    const db = { select: vi.fn(), update: vi.fn() } as any;
    const app = buildApp("local_trusted", db);

    const res = await request(app).get("/actor");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ type: "none", source: "none" });
    expect(res.body.userId).not.toBe("local-board");
    expect(res.body.isInstanceAdmin).not.toBe(true);
    // No credential presented, so no DB lookup should even occur.
    expect(db.select).not.toHaveBeenCalled();
  });

  it("matches the already-fail-closed 'authenticated' mode for anonymous requests (no drift between modes)", async () => {
    const dbLocalTrusted = { select: vi.fn(), update: vi.fn() } as any;
    const dbAuthenticated = { select: vi.fn(), update: vi.fn() } as any;

    const resLocalTrusted = await request(buildApp("local_trusted", dbLocalTrusted)).get("/actor");
    const resAuthenticated = await request(buildApp("authenticated", dbAuthenticated)).get("/actor");

    expect(resLocalTrusted.body).toEqual(resAuthenticated.body);
    expect(resLocalTrusted.body).toEqual({ type: "none", source: "none" });
  });

  it("still resolves a real agent API key to its own agent identity in local_trusted mode", async () => {
    const rawToken = "test-agent-key-token";
    const keyHash = createHash("sha256").update(rawToken).digest("hex");

    const db = {
      select: vi
        .fn()
        // 1st lookup: findBoardApiKeyByToken checks boardApiKeys first — no match.
        .mockImplementationOnce(() => createSelectChain([]))
        // 2nd lookup: agentApiKeys by keyHash — match. responsibleUserId is
        // required (post-#104 responsible-user attribution) or resolution
        // fails closed with 403 RESPONSIBLE_USER_UNAVAILABLE.
        .mockImplementationOnce(() =>
          createSelectChain([
            { id: "key-1", agentId: "agent-42", companyId: "company-1", keyHash, responsibleUserId: "user-1" },
          ]),
        )
        // 3rd lookup: agents by id.
        .mockImplementationOnce(() =>
          createSelectChain([{ id: "agent-42", companyId: "company-1", status: "active" }]),
        )
        // 4th/5th: loadResponsibleUserMemberships resolves the responsible
        // user (authUsers) and their active company memberships, in that
        // Promise.all array order.
        .mockImplementationOnce(() => createSelectChain([{ id: "user-1" }]))
        .mockImplementationOnce(() => createSelectChain([])),
      update: vi.fn(() => createUpdateChain()),
    } as any;

    const app = buildApp("local_trusted", db);
    const res = await request(app).get("/actor").set("Authorization", `Bearer ${rawToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId: "agent-42",
      companyId: "company-1",
      source: "agent_key",
      onBehalfOfUserId: "user-1",
    });
    // Never the board/admin identity, even though a credential was presented.
    expect(res.body.type).not.toBe("board");
  });

  it("does not resolve an agent whose status is terminated, even with a matching key hash", async () => {
    const rawToken = "terminated-agent-token";
    const keyHash = createHash("sha256").update(rawToken).digest("hex");

    const db = {
      select: vi
        .fn()
        .mockImplementationOnce(() => createSelectChain([]))
        .mockImplementationOnce(() =>
          createSelectChain([
            { id: "key-2", agentId: "agent-99", companyId: "company-1", keyHash, responsibleUserId: "user-1" },
          ]),
        )
        .mockImplementationOnce(() =>
          createSelectChain([{ id: "agent-99", companyId: "company-1", status: "terminated" }]),
        ),
      update: vi.fn(() => createUpdateChain()),
    } as any;

    const app = buildApp("local_trusted", db);
    const res = await request(app).get("/actor").set("Authorization", `Bearer ${rawToken}`);

    // A terminated agent is now rejected outright (401) rather than falling
    // through to an anonymous "none" actor — a stricter, correct behavior
    // that landed on master independently of PAP-1975; this credential
    // still never resolves to a live agent or board identity either way.
    expect(res.status).toBe(401);
  });
});
