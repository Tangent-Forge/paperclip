import { test, expect } from "./fixtures/board-auth.js";
import type { APIRequestContext, Page } from "@playwright/test";
import { ciSmokeLabScenarios, type SmokeLabLifecycleTool, type SmokeLabScenario, type SmokeRunStepPath } from "./smoke-lab.catalog";

type SmokeRunStepStatus = "pass" | "fail" | "skipped";

const SCREENSHOT_DIR = "test-results/smoke-lab";

type Json = Record<string, unknown>;
type Seed = { companyId: string; prefix: string };
type Scout = { id: string; name: string };
type SmokeRun = { id: string; status: string };
type SmokeRunStepResult = {
  step: { id: string; status: SmokeRunStepStatus };
  summary: Record<string, unknown>;
};
type ToolConnection = {
  id: string;
  name: string;
  transport: "mcp_remote" | "local_stdio";
  applicationId: string;
  enabled: boolean;
  status?: string;
  config?: Record<string, unknown> | null;
};
type ToolCatalogEntry = {
  id: string;
  toolName: string;
  name: string;
  riskLevel?: string | null;
  status?: string | null;
};
type FixtureInstall = {
  connections: ToolConnection[];
  catalog: ToolCatalogEntry[];
};
type TestCallResult = {
  decision: "allowed" | "ask_first" | "off";
  invocationId: string;
  actionRequestId?: string;
  error?: { reasonCode?: string | null; message: string };
};
type GatewaySession = {
  sessionId: string;
  token: string;
  toolsUrl: string;
  callUrl: string;
};

async function json<T = Json>(response: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${response.url()} failed ${response.status()}: ${body}`).toBe(true);
  return JSON.parse(body) as T;
}

async function expectError(response: Awaited<ReturnType<APIRequestContext["get"]>>, status: number) {
  const body = await response.text();
  expect(response.status(), `${response.url()} expected ${status}, got ${response.status()}: ${body}`).toBe(status);
  return body;
}

async function newCompany(request: APIRequestContext, label: string): Promise<Seed> {
  const body = await json<{ id: string; issuePrefix?: string; prefix?: string; urlKey?: string }>(
    await request.post("/api/companies", { data: { name: `Smoke Lab ${label} ${Date.now()}` } }),
  );
  return { companyId: body.id, prefix: body.issuePrefix ?? body.prefix ?? body.urlKey ?? "E2E" };
}

async function createScout(request: APIRequestContext, companyId: string): Promise<Scout> {
  const body = await json<{ id: string; name: string }>(
    await request.post(`/api/companies/${companyId}/agents`, {
      data: {
        name: `Smoke Scout ${Date.now()}`,
        role: "qa",
        title: "Smoke Lab scout",
        capabilities: "Runs deterministic Smoke Lab fixture calls.",
        adapterType: "process",
        adapterConfig: { command: "node", args: ["-e", "setTimeout(() => {}, 1000)"] },
      },
    }),
  );
  return { id: body.id, name: body.name };
}

async function enableSmokeLab(request: APIRequestContext) {
  await json(await request.patch("/api/instance/settings/experimental", { data: { enableSmokeLab: true, enableApps: true } }));
}

async function createSmokeRun(request: APIRequestContext, companyId: string) {
  const result = await json<{ run: SmokeRun }>(
    await request.post(`/api/companies/${companyId}/smoke-lab/runs`, {
      data: {
        trigger: "ci",
        summary: {
          catalog: "tests/e2e/smoke-lab.catalog.ts",
          scenarioCount: ciSmokeLabScenarios.length,
        },
      },
    }),
  );
  return result.run;
}

async function updateSmokeRun(
  request: APIRequestContext,
  companyId: string,
  runId: string,
  status: "passed" | "failed",
  summary: Json,
) {
  await json(await request.patch(`/api/companies/${companyId}/smoke-lab/runs/${runId}`, {
    data: { status, summary },
  }));
}

async function recordStep(
  request: APIRequestContext,
  companyId: string,
  runId: string,
  input: {
    path: SmokeRunStepPath;
    scenarioStep: string;
    status: SmokeRunStepStatus;
    detail?: string | null;
    screenshotPath?: string | null;
    durationMs?: number | null;
  },
): Promise<SmokeRunStepResult> {
  return await json<SmokeRunStepResult>(
    await request.post(`/api/companies/${companyId}/smoke-lab/runs/${runId}/steps`, {
      data: {
        path: input.path,
        scenarioStep: input.scenarioStep,
        status: input.status,
        detail: input.detail ?? null,
        screenshotArtifactRef: input.screenshotPath
          ? { kind: "playwright_screenshot", path: input.screenshotPath }
          : null,
        durationMs: input.durationMs ?? null,
      },
    }),
  );
}

async function screenshot(page: Page, scenario: SmokeLabScenario, step: string) {
  const path = `${SCREENSHOT_DIR}/${scenario.path.toLowerCase()}-${step}.png`;
  await page.screenshot({ path, fullPage: true });
  return path;
}

// This suite loops over multiple scenarios (P1-P7) whose evidence-capture
// steps repeatedly navigate between a handful of URLs (notably
// `/apps/connections`, hit from both navigateForEvidence's "attention" case
// and the schemaChangeQuarantine step below) — an earlier scenario's step
// can easily leave the browser already sitting on the exact URL a later
// scenario's step navigates to next.
//
// Root-caused via a captured Playwright trace: the default `waitUntil:
// "load"` genuinely hung indefinitely on exactly that "already there" case
// (this SPA's client-side router doesn't always trigger a fresh `load`
// event for a same-URL `page.goto`) — the one code path this suite could
// never previously reach, since every prior CI run 403'd at
// company-creation, step 1, before PAP-1975's board-credential fix.
//
// `waitUntil: "commit"` (fires once navigation is committed, not on full
// load) sidesteps that hang, but on its own is NOT sufficient: an earlier
// version of this fix used it with no follow-up wait at several call sites
// and traded the indefinite hang for an intermittent blank-page failure
// instead — `commit` can return before this SPA has rendered anything, and
// a screenshot taken immediately after captures exactly that (confirmed via
// a captured trace + matching blank screenshots, including inside a run
// that still reported overall pass). Every helper below pairs the
// `commit`-mode goto with a real content assertion instead — Playwright's
// web-first `expect(...).toBeVisible()` polls/retries up to its own
// timeout, so it's the assertion, not the goto, that provides the actual
// "did this page really load" guarantee. Used at every goto call site in
// this file, not just navigateForEvidence's. Timeouts are 30s, not
// Playwright's 5s default — this environment has shown real render latency
// under concurrent load, and an assertion that's slow-but-eventually-true is
// a very different failure mode than the content genuinely being wrong.
async function gotoActivity(page: Page, seed: Seed, connectionId: string) {
  await page.goto(`/${seed.prefix}/apps/${connectionId}/activity`, { waitUntil: "commit" });
  await expect(page.getByRole("heading", { name: "Recent activity" })).toBeVisible({ timeout: 30_000 });
}

async function gotoReview(page: Page, seed: Seed, connectionId: string) {
  await page.goto(`/${seed.prefix}/apps/${connectionId}/review`, { waitUntil: "commit" });
  // ReviewQueueCard.tsx: the "Waiting for your OK" <h2> only renders when
  // there's at least one pending item; the empty state renders only the
  // plain "Nothing is waiting for your OK right now." text, no heading at
  // all. This regex's second alternative used to read `new actions?
  // (need|to) review`, which never matched either real state — confirmed
  // by reading the component directly after this assertion started
  // legitimately failing (not hanging/blank) against a real, correctly
  // rendered "Waiting for your OK" page showing 1 real pending item.
  await expect(page.getByText(/Nothing is waiting for your OK right now\.|Waiting for your OK/i).first()).toBeVisible({ timeout: 30_000 });
}

async function gotoConnectionDetail(page: Page, seed: Seed, connectionId: string) {
  await page.goto(`/${seed.prefix}/apps/${connectionId}`, { waitUntil: "commit" });
  await expect(page.getByRole("heading", { name: /Smoke Lab/i }).first()).toBeVisible({ timeout: 30_000 });
}

async function gotoConnectionsList(page: Page, seed: Seed) {
  await page.goto(`/${seed.prefix}/apps/connections`, { waitUntil: "commit" });
  await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible({ timeout: 30_000 });
}

async function navigateForEvidence(page: Page, seed: Seed, connectionId: string, scenario: SmokeLabScenario) {
  if (scenario.uiEntryPath === "advanced") {
    await page.goto(`/${seed.prefix}/apps/advanced`, { waitUntil: "commit" });
    await expect(page.getByRole("heading", { name: "Advanced setup" })).toBeVisible({ timeout: 30_000 });
    return;
  }
  if (scenario.uiEntryPath === "review") {
    await gotoReview(page, seed, connectionId);
    return;
  }
  if (scenario.uiEntryPath === "activity") {
    await gotoActivity(page, seed, connectionId);
    return;
  }
  if (scenario.uiEntryPath === "attention") {
    await gotoConnectionsList(page, seed);
    return;
  }
  await gotoConnectionDetail(page, seed, connectionId);
}

async function runRecordedStep(
  page: Page,
  request: APIRequestContext,
  seed: Seed,
  runId: string,
  scenario: SmokeLabScenario,
  step: string,
  action: () => Promise<string | null | undefined>,
) {
  const start = Date.now();
  try {
    const screenshotHint = await action();
    const screenshotPath = await screenshot(page, scenario, step);
    await recordStep(request, seed.companyId, runId, {
      path: scenario.path,
      scenarioStep: step,
      status: "pass",
      detail: screenshotHint ?? null,
      screenshotPath,
      durationMs: Date.now() - start,
    });
  } catch (error) {
    const screenshotPath = await screenshot(page, scenario, `${step}-failed`).catch(() => null);
    await recordStep(request, seed.companyId, runId, {
      path: scenario.path,
      scenarioStep: step,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      screenshotPath,
      durationMs: Date.now() - start,
    }).catch(() => undefined);
    throw error;
  }
}

async function startAndInstallFixtures(request: APIRequestContext, companyId: string): Promise<FixtureInstall> {
  await json(await request.post(`/api/companies/${companyId}/smoke-lab/services/start`));
  return await json<FixtureInstall>(await request.post(`/api/companies/${companyId}/smoke-lab/install-fixtures`));
}

function connectionForScenario(fixtures: FixtureInstall, scenario: SmokeLabScenario): ToolConnection {
  const preferStdio = scenario.transport === "local_stdio" || scenario.transport === "plugin";
  const transport = preferStdio ? "local_stdio" : "mcp_remote";
  const connection = fixtures.connections.find((candidate) => candidate.transport === transport);
  if (!connection) throw new Error(`Missing ${transport} fixture connection for ${scenario.path}`);
  return connection;
}

async function catalog(request: APIRequestContext, connectionId: string) {
  return await json<{ catalog: ToolCatalogEntry[] }>(await request.get(`/api/tool-connections/${connectionId}/catalog`));
}

async function testCall(
  request: APIRequestContext,
  connectionId: string,
  scout: Scout,
  tool: SmokeLabLifecycleTool,
) {
  return await json<TestCallResult>(
    await request.post(`/api/tool-connections/${connectionId}/test-calls`, {
      data: { agentId: scout.id, toolName: tool.name, parameters: tool.parameters },
    }),
  );
}

async function policy(
  request: APIRequestContext,
  companyId: string,
  body: {
    name: string;
    policyType: "allow" | "block" | "require_approval";
    priority: number;
    selectors: Record<string, unknown>;
  },
) {
  return await json<{ id: string }>(await request.post(`/api/companies/${companyId}/tools/policies`, { data: body }));
}

async function approveActionRequest(request: APIRequestContext, companyId: string, actionRequestId: string) {
  await json(await request.post(`/api/tool-gateway/action-requests/${actionRequestId}/approve`, {
    data: { companyId },
  }));
}

async function pollTestCall(
  request: APIRequestContext,
  connectionId: string,
  actionRequestId: string,
  expectedPhase: string,
) {
  for (let i = 0; i < 40; i += 1) {
    const status = await json<{ phase: string }>(
      await request.get(`/api/tool-connections/${connectionId}/test-calls/${actionRequestId}`),
    );
    if (status.phase === expectedPhase) return status;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for test-call ${actionRequestId} phase ${expectedPhase}`);
}

async function expectAuditEvent(
  request: APIRequestContext,
  companyId: string,
  options: { connectionId: string; agentId: string; search: string },
) {
  const audit = await json<{ events: Array<Json> }>(
    await request.get(
      `/api/tool-gateway/audit?companyId=${companyId}&app=${options.connectionId}&agent=${options.agentId}&search=${encodeURIComponent(options.search)}&limit=50`,
    ),
  );
  expect(audit.events.length, `expected audit/activity row matching ${options.search}`).toBeGreaterThan(0);
}

async function createGatewaySession(request: APIRequestContext, companyId: string, scout: Scout): Promise<GatewaySession> {
  const invoked = await json<{ id: string }>(await request.post(`/api/agents/${scout.id}/heartbeat/invoke`));
  return await json<GatewaySession>(
    await request.post("/api/tool-gateway/sessions", {
      data: { companyId, agentId: scout.id, runId: invoked.id, ttlMs: 60_000 },
    }),
  );
}

async function gatewayFetch(request: APIRequestContext, path: string, token: string, data?: Json) {
  const headers = { "x-paperclip-tool-gateway-token": token };
  if (data) return await request.post(path, { headers, data });
  return await request.get(path, { headers });
}

test.describe.serial("Smoke Lab scenario catalog mirror", () => {
  // Bumped from 240s to 360s, then to 600s: with 30s-budgeted, retry-polling
  // assertions now on every one of the ~60 navigations across all 7
  // scenarios (see the goto helpers above), a few genuinely slow-but-correct
  // renders under load can legitimately push the cumulative total past the
  // old ceiling even when no single step is actually stuck. An independent
  // review measured 270s to complete cleanly at moderate host load, but two
  // runs under heavier contention were still only 91-95% through the
  // scenario list at the 360s mark (a ~380-395s actual requirement) — 360s
  // left under ~25% margin, which moderate load erased. 600s restores a
  // real safety margin without masking a genuine hang: a truly stuck step
  // still fails its own 30s per-assertion timeout long before the suite
  // timeout would ever be reached.
  test.setTimeout(600_000);

  test("records the P1-P7 CI-safe Smoke Lab lifecycle into the results API @smoke-lab", async ({ page, request }) => {
    const seed = await newCompany(request, "catalog");
    const scout = await createScout(request, seed.companyId);
    await enableSmokeLab(request);
    const smokeRun = await createSmokeRun(request, seed.companyId);
    const failed: string[] = [];

    try {
      for (const scenario of ciSmokeLabScenarios) {
        const fixtures = await startAndInstallFixtures(request, seed.companyId);
        const connection = connectionForScenario(fixtures, scenario);

        await runRecordedStep(page, request, seed, smokeRun.id, scenario, "connect", async () => {
          await navigateForEvidence(page, seed, connection.id, scenario);
          return scenario.lifecycle.connect;
        });

        await runRecordedStep(page, request, seed, smokeRun.id, scenario, "discover-catalog", async () => {
          const discovered = await catalog(request, connection.id);
          expect(discovered.catalog.map((entry) => entry.toolName)).toContain(scenario.lifecycle.allowedRead.name);
          await navigateForEvidence(page, seed, connection.id, scenario);
          return `${scenario.lifecycle.discoverCatalog}: ${discovered.catalog.length} entries`;
        });

        await runRecordedStep(page, request, seed, smokeRun.id, scenario, "allowed-read", async () => {
          const read = await testCall(request, connection.id, scout, scenario.lifecycle.allowedRead);
          expect(read.decision).toBe("allowed");
          expect(read.error).toBeUndefined();
          await expectAuditEvent(request, seed.companyId, {
            connectionId: connection.id,
            agentId: scout.id,
            search: scenario.lifecycle.allowedRead.name,
          });
          await gotoActivity(page, seed, connection.id);
          return `Allowed read ${scenario.lifecycle.allowedRead.name}`;
        });

        await runRecordedStep(page, request, seed, smokeRun.id, scenario, "ask-first-write-approved", async () => {
          await policy(request, seed.companyId, {
            name: `${scenario.path} require approval ${Date.now()}`,
            policyType: "require_approval",
            priority: 10,
            selectors: { connectionId: connection.id, toolNames: [scenario.lifecycle.askFirstWrite.name] },
          });
          const pending = await testCall(request, connection.id, scout, scenario.lifecycle.askFirstWrite);
          expect(pending.decision).toBe("ask_first");
          expect(pending.actionRequestId).toBeTruthy();
          await gotoReview(page, seed, connection.id);
          await approveActionRequest(request, seed.companyId, pending.actionRequestId!);
          await pollTestCall(request, connection.id, pending.actionRequestId!, "done");
          return `Approved ask-first call ${scenario.lifecycle.askFirstWrite.name}`;
        });

        await runRecordedStep(page, request, seed, smokeRun.id, scenario, "denied-blocked-call", async () => {
          await policy(request, seed.companyId, {
            name: `${scenario.path} block ${Date.now()}`,
            policyType: "block",
            priority: 1,
            selectors: { connectionId: connection.id, toolNames: [scenario.lifecycle.deniedCall.name] },
          });
          const denied = await testCall(request, connection.id, scout, scenario.lifecycle.deniedCall);
          expect(denied.decision).toBe("off");
          expect(denied.error?.reasonCode).toBeTruthy();
          await gotoReview(page, seed, connection.id);
          return `Blocked call ${scenario.lifecycle.deniedCall.name}: ${denied.error?.reasonCode}`;
        });

        await runRecordedStep(page, request, seed, smokeRun.id, scenario, "schema-change-quarantine", async () => {
          if (connection.transport !== "mcp_remote") {
            await gotoActivity(page, seed, connection.id);
            return "Non-HTTP path records governance/quarantine evidence through fixture metadata.";
          }
          await json<ToolConnection>(await request.patch(`/api/tool-connections/${connection.id}`, {
            data: { config: { ...(connection.config ?? {}), quarantineNewEntries: true } },
          }));
          await policy(request, seed.companyId, {
            name: `${scenario.path} allow schema flip ${Date.now()}`,
            policyType: "allow",
            priority: 5,
            selectors: { connectionId: connection.id, toolNames: [scenario.lifecycle.schemaChangeQuarantine.name] },
          });
          const flipped = await testCall(request, connection.id, scout, scenario.lifecycle.schemaChangeQuarantine);
          expect(flipped.decision).toBe("allowed");
          expect(flipped.error).toBeUndefined();
          const refresh = await json<{ quarantinedCount: number }>(
            await request.post(`/api/tool-connections/${connection.id}/catalog/refresh`),
          );
          expect(refresh.quarantinedCount).toBeGreaterThan(0);
          await gotoConnectionsList(page, seed);
          return `Catalog refresh quarantined ${refresh.quarantinedCount} changed entries.`;
        });

        await runRecordedStep(page, request, seed, smokeRun.id, scenario, "revoke", async () => {
          if (scenario.transport === "gateway_session") {
            const session = await createGatewaySession(request, seed.companyId, scout);
            const listed = await gatewayFetch(request, session.toolsUrl, session.token);
            expect(listed.ok()).toBe(true);
            await json(await request.post(`/api/tool-gateway/sessions/${session.sessionId}/revoke`, {
              data: { companyId: seed.companyId },
            }));
            await expectError(await gatewayFetch(request, session.toolsUrl, session.token), 401);
            await gotoActivity(page, seed, connection.id);
            return scenario.lifecycle.revoke;
          }
          const disabled = await json<ToolConnection>(await request.patch(`/api/tool-connections/${connection.id}`, {
            data: { enabled: false },
          }));
          expect(disabled.enabled).toBe(false);
          await gotoConnectionDetail(page, seed, connection.id);
          await json<ToolConnection>(await request.patch(`/api/tool-connections/${connection.id}`, {
            data: { enabled: true },
          }));
          return scenario.lifecycle.revoke;
        });

        await runRecordedStep(page, request, seed, smokeRun.id, scenario, "audit-evidence", async () => {
          await expectAuditEvent(request, seed.companyId, {
            connectionId: connection.id,
            agentId: scout.id,
            search: scenario.lifecycle.allowedRead.name,
          });
          await gotoActivity(page, seed, connection.id);
          return scenario.lifecycle.auditEvidence;
        });
      }
    } catch (error) {
      failed.push(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      await updateSmokeRun(request, seed.companyId, smokeRun.id, failed.length > 0 ? "failed" : "passed", {
        catalog: "tests/e2e/smoke-lab.catalog.ts",
        scenarioCount: ciSmokeLabScenarios.length,
        failed,
      }).catch(() => undefined);
    }

    const completed = await json<{ run: SmokeRun; steps: Array<{ path: string; status: string; screenshotArtifactRef: Json | null }> }>(
      await request.get(`/api/companies/${seed.companyId}/smoke-lab/runs/${smokeRun.id}`),
    );
    expect(completed.run.status).toBe("passed");
    for (const scenario of ciSmokeLabScenarios) {
      const steps = completed.steps.filter((step) => step.path === scenario.path);
      expect(steps.length, `${scenario.path} should record lifecycle steps`).toBeGreaterThanOrEqual(8);
      expect(steps.every((step) => step.status === "pass")).toBe(true);
      expect(steps.every((step) => step.screenshotArtifactRef?.kind === "playwright_screenshot")).toBe(true);
    }
  });
});
