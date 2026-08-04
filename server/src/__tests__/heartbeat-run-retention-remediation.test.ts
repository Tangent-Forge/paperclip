import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getRunLogStore, resetRunLogStoreForTests } from "../services/run-log-store.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run retention remediation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat run retention remediation", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let logRoot: string | null = null;
  const originalRunLogBasePath = process.env.RUN_LOG_BASE_PATH;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-retention-remediation-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    logRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-retention-remediation-logs-"));
    process.env.RUN_LOG_BASE_PATH = logRoot;
    resetRunLogStoreForTests();
  });

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
    if (logRoot) await fs.rm(logRoot, { recursive: true, force: true });
    if (originalRunLogBasePath === undefined) delete process.env.RUN_LOG_BASE_PATH;
    else process.env.RUN_LOG_BASE_PATH = originalRunLogBasePath;
    resetRunLogStoreForTests();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seedRetainedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Retention Test Co",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const store = getRunLogStore();
    const handle = await store.begin({ companyId, agentId, runId });
    if (!logRoot) throw new Error("RUN_LOG_BASE_PATH test root was not initialized");
    await fs.writeFile(
      path.join(logRoot, handle.logRef),
      `${JSON.stringify({
        stream: "stdout",
        chunk: "OPENAI_API_KEY=test-openai-value\nSAFE_FLAG=not-sensitive",
        ts: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    const logSummary = await store.finalize(handle);

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "failed",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      logStore: handle.store,
      logRef: handle.logRef,
      logBytes: logSummary.bytes,
      logSha256: logSummary.sha256,
      stdoutExcerpt: "OPENAI_API_KEY=stdout-openai-value",
      stderrExcerpt: "PAPERCLIP_AGENT_JWT_SECRET=jwt-secret-value",
      error: "GITHUB_TOKEN=github-token-value",
      resultJson: {
        stdout: "ANTHROPIC_API_KEY=result-anthropic-value",
        nested: {
          output: "PAPERCLIP_API_KEY=paperclip-result-secret",
        },
      },
      contextSnapshot: {},
    });
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId,
      seq: 1,
      eventType: "adapter.invoke",
      stream: "system",
      level: "info",
      message: "OPENAI_API_KEY=event-message-openai-value",
      payload: {
        env: {
          OPENAI_API_KEY: "event-payload-openai-value",
        },
        output: "AUTH_TOKEN=event-token-secret",
      },
    });

    return { companyId, agentId, runId };
  }

  it("redacts sensitive KEY=value output from retained log and DB run fields", async () => {
    const { runId } = await seedRetainedRun();
    const service = heartbeatService(db);

    const result = await service.remediateRunRetention(runId, {
      action: "redact",
      reason: "test redaction",
    });

    expect(result.logRemediation?.redactedChunks).toBe(1);

    const remediatedRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    const log = await service.readLog(runId);
    const eventRows = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    const retained = JSON.stringify({
      log,
      remediatedRun,
      eventRows,
    });

    expect(retained).toContain("OPENAI_API_KEY");
    expect(retained).toContain("***REDACTED***");
    expect(retained).not.toContain("test-openai-value");
    expect(retained).not.toContain("stdout-openai-value");
    expect(retained).not.toContain("jwt-secret-value");
    expect(retained).not.toContain("github-token-value");
    expect(retained).not.toContain("result-anthropic-value");
    expect(retained).not.toContain("paperclip-result-secret");
    expect(retained).not.toContain("event-message-openai-value");
    expect(retained).not.toContain("event-payload-openai-value");
    expect(retained).not.toContain("event-token-secret");
  });

  it("purges retained log bytes and DB excerpts when redaction is not enough", async () => {
    const { runId } = await seedRetainedRun();
    const service = heartbeatService(db);

    const result = await service.remediateRunRetention(runId, {
      action: "purge",
      reason: "test purge",
    });

    expect(result.logRemediation?.bytesAfter).toBe(0);
    const remediatedRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    const log = await service.readLog(runId);
    const adapterEvent = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.eventType, "adapter.invoke"))
      .then((rows) => rows[0]);

    expect(log.content).toBe("");
    expect(remediatedRun.stdoutExcerpt).toBeNull();
    expect(remediatedRun.stderrExcerpt).toBeNull();
    expect(remediatedRun.error).toBeNull();
    expect(remediatedRun.resultJson).toMatchObject({
      redacted: true,
      redactionMode: "purge",
    });
    expect(adapterEvent.message).toBeNull();
    expect(adapterEvent.payload).toBeNull();
  });
});
