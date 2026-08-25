import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * E2E: Paperclip Companion plugin — full authenticated-human flow.
 *
 * Against the disposable `local_trusted` instance the shared
 * `playwright.config.ts` webServer boots (fresh PAPERCLIP_HOME, dedicated
 * port, no real production instance ever touched), this spec:
 *
 *   1. Installs the built plugin from its local package directory and
 *      configures it for a freshly created company (own instance config;
 *      no Anthropic key — see the "On the LLM call" note below for why).
 *   2. Opens Companion, creates a thread, sends a message.
 *   3. Waits for Companion's persisted reply.
 *   4. Sees the evidence block rendered under that reply.
 *   5. Proposes actions from replies and approves one / rejects one as the
 *      authenticated human (the `local_trusted` implicit board user).
 *   6. Reloads the page and asserts the same thread/messages/proposal
 *      (with the same decided status) are still there — both via the
 *      rendered UI and via a direct read of the plugin's own data.
 *
 * On the LLM call: this spec never attempts to reach the real Anthropic API
 * and never uses a real API key. `anthropicApiKeySecretRef` is deliberately
 * left unconfigured. `sendMessage()` in `companion-service.ts` does not throw
 * when the LLM key isn't configured — it always persists both the human
 * message and a Companion reply, using `"I couldn't complete that request:
 * ..."` as the reply body (see `callCompanionModel` / `sendMessage`). That is
 * the real, deterministic behavior asserted below: a persisted human message
 * + a persisted Companion message with evidence attached, whatever the reply
 * text is — not a scripted/faked assistant reply, which would require
 * intercepting a server-side outbound fetch that Playwright cannot reach.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, "../../packages/plugins/paperclip-plugin-companion");
const PLUGIN_ID = "paperclipai.companion";
// The manifest's declared page-slot route (src/constants.ts PAGE_ROUTE). The
// company-context page URL is reached via the app's `:pluginRoutePath/*`
// catch-all route, which matches on this stable route string — NOT via
// `/plugins/:pluginId`, whose `:pluginId` param is matched against the
// plugin's DB UUID (`ui-contributions`' `contribution.pluginId`), not the
// plugin key string used here for the CLI/REST API.
const PAGE_ROUTE = "companion";
// Mirrors tests/e2e/playwright.config.ts's own PORT computation — the
// disposable instance's own port, never the real instance's :3100.
const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const SELF_ORIGIN = `http://127.0.0.1:${PORT}`;

const HUMAN_MESSAGE = "What commit is Paperclip currently running, and what is the deployment status?";
const SECOND_HUMAN_MESSAGE = "What should I verify next?";

interface CompanionThreadSnapshot {
  thread: { id: string };
  messages: Array<{ id: string; role: string; body: string }>;
  proposals: Array<{ id: string; status: string; decided_by_user_id: string | null }>;
}

async function fetchThreadSnapshot(request: APIRequestContext, companyId: string): Promise<CompanionThreadSnapshot> {
  const threadsRes = await request.post(`/api/plugins/${PLUGIN_ID}/data/threads`, {
    data: { companyId, params: { companyId } },
  });
  expect(threadsRes.ok(), `threads data call failed ${threadsRes.status()}: ${await threadsRes.text()}`).toBe(true);
  const threadsBody = await threadsRes.json();
  const threads = threadsBody.data as Array<{ id: string }>;
  expect(threads, "exactly one thread should exist for this freshly-created company").toHaveLength(1);

  const detailRes = await request.post(`/api/plugins/${PLUGIN_ID}/data/thread`, {
    data: { companyId, params: { companyId, threadId: threads[0].id } },
  });
  expect(detailRes.ok(), `thread data call failed ${detailRes.status()}: ${await detailRes.text()}`).toBe(true);
  const detailBody = await detailRes.json();
  return detailBody.data as CompanionThreadSnapshot;
}

test.describe.serial("Paperclip Companion", () => {
  let companyId: string;
  let prefix: string;
  let persistedSnapshot: CompanionThreadSnapshot;

  test.beforeAll(async ({ request }) => {
    // Install the built plugin package from disk (dist/ must already exist —
    // `pnpm --filter @paperclipai/plugin-companion build` before this run).
    const installRes = await request.post("/api/plugins/install", {
      data: { packageName: PLUGIN_DIR, isLocalPath: true },
    });
    expect(installRes.ok(), `plugin install failed ${installRes.status()}: ${await installRes.text()}`).toBe(true);
    const installed = await installRes.json();
    expect(installed.status, `plugin did not reach ready status: ${JSON.stringify(installed)}`).toBe("ready");
    expect(installed.pluginKey).toBe(PLUGIN_ID);

    const pluginRes = await request.get(`/api/plugins/${PLUGIN_ID}`);
    expect(pluginRes.ok(), `plugin detail failed ${pluginRes.status()}: ${await pluginRes.text()}`).toBe(true);
    const plugin = await pluginRes.json();
    expect(plugin.status).toBe("ready");
    expect(plugin.manifestJson?.database).toMatchObject({ namespaceSlug: "companion", migrationsDir: "migrations" });

    const contributionsRes = await request.get("/api/plugins/ui-contributions");
    expect(contributionsRes.ok(), `ui contributions failed ${contributionsRes.status()}: ${await contributionsRes.text()}`).toBe(true);
    const contributions = (await contributionsRes.json()) as Array<{ pluginKey: string; slots: Array<{ type: string; routePath?: string }> }>;
    const contribution = contributions.find((item) => item.pluginKey === PLUGIN_ID);
    expect(contribution, "installed plugin must register UI contributions").toBeTruthy();
    expect(contribution?.slots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "page", routePath: PAGE_ROUTE }),
        expect.objectContaining({ type: "routeSidebar", routePath: PAGE_ROUTE }),
      ]),
    );

    const companyRes = await request.post("/api/companies", {
      data: { name: `Companion E2E ${Date.now()}` },
    });
    expect(companyRes.ok(), `create company failed ${companyRes.status()}: ${await companyRes.text()}`).toBe(true);
    const company = await companyRes.json();
    companyId = company.id;
    prefix = company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E";

    // Leave `anthropicApiKeySecretRef` unconfigured: the deterministic
    // provider-failure path persists a real Companion response and evidence
    // without contacting an external provider or materializing any secret.
    const configRes = await request.post(`/api/plugins/${PLUGIN_ID}/config`, {
      data: {
        companyId,
        configJson: {
          // Loopback + this disposable instance's own port — passes
          // healthCheckUrl's loopback-only host allowlist and never points
          // at the real production instance's :3100.
          healthCheckUrl: `${SELF_ORIGIN}/api/health`,
        },
      },
    });
    expect(configRes.ok(), `plugin config failed ${configRes.status()}: ${await configRes.text()}`).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/plugins/${PLUGIN_ID}`).catch(() => undefined);
    if (companyId) {
      await request.delete(`/api/companies/${companyId}`).catch(() => undefined);
    }
  });

  test("thread -> message -> evidence -> propose -> approve -> survives reload", async ({ page }) => {
    // No LLM key is configured (see beforeAll), so Companion's reply comes
    // back on the fast "not configured" branch — no outbound network call is
    // attempted. The generous budget here is for the vite-dev-middleware
    // cold compile on this spec's first navigation (observed ~20s), not for
    // the companion flow itself.
    test.setTimeout(120_000);

    await page.goto(`/${prefix}/${PAGE_ROUTE}`);

    // The manifest registers CompanionPage under BOTH a `page` slot and a
    // `routeSidebar` slot for this same route (src/manifest.ts), so the host
    // app mounts two independent instances of the component side by side
    // (main content + route sidebar) — confirmed by a strict-mode "resolved
    // to 2 elements" failure when querying the bare page for this heading.
    // Scope every interaction to the `#main-content` instance so clicks and
    // assertions consistently target one instance instead of racing/matching
    // both.
    const main = page.locator("#main-content");
    await expect(main.getByRole("heading", { name: "Paperclip Companion" })).toBeVisible({ timeout: 20_000 });

    // 1. Authenticated human (the local_trusted implicit board user) opens
    // Companion — already true by virtue of the page having loaded and not
    // showing the "must be signed in" gate.
    await expect(main.getByText(/must be signed in as an authenticated human user/i)).toHaveCount(0);

    // 2. Create a thread.
    await main.getByRole("button", { name: "+ New conversation" }).click();
    const composer = main.getByPlaceholder("Ask Companion…");
    await expect(composer).toBeVisible({ timeout: 20_000 });

    // 3. Send a message. Human + Companion messages are persisted together
    // server-side and only appear once the single send-message call
    // resolves, so wait on the human message with the same generous budget
    // used for Companion's reply below rather than assuming it appears fast.
    await composer.fill(HUMAN_MESSAGE);
    await main.getByRole("button", { name: "Send", exact: true }).click();
    await expect(main.getByText(HUMAN_MESSAGE)).toBeVisible({ timeout: 30_000 });

    // 4. Receive a persisted Companion reply. See beforeAll's comment for why
    // this asserts the real, deterministic "LLM API key is not configured"
    // error-path reply rather than a faked happy-path one.
    // .first(): the message bubble is the only match before a proposal
    // exists, but once proposed, the proposal card's own summary ("Follow up
    // on: <reply text>") embeds the same substring — .first() pins this to
    // the actual message bubble (which precedes the proposal card in the
    // DOM), not the proposal summary, in both the pre- and post-proposal
    // assertions below.
    const companionReply = main.getByText(/I couldn't complete that request: Companion's LLM API key is not configured/i).first();
    await expect(companionReply).toBeVisible({ timeout: 10_000 });

    // 5. Evidence block rendered under the reply (gathered independently of
    // the LLM outcome, so it is always attached to the reply).
    await expect(main.getByText("deployment_health")).toHaveCount(1);
    await expect(main.getByText("github")).toBeVisible();

    // 6. Propose an action from that reply.
    await main.getByRole("button", { name: "Propose next action from this reply" }).click();
    await expect(main.getByText("Proposed action")).toBeVisible({ timeout: 10_000 });

    // 7. Approve it through the authenticated human route (click Approve in
    // the UI).
    await main.getByRole("button", { name: "Approve" }).click();
    const decidedStatus = main.getByText(/^Approved by /);
    await expect(decidedStatus).toBeVisible({ timeout: 15_000 });
    const decidedStatusText = (await decidedStatus.textContent())?.trim();
    expect(decidedStatusText).toMatch(/^Approved by \S+/);

    // Exercise the opposite authenticated-human decision on a second,
    // independently persisted proposal.
    await composer.fill(SECOND_HUMAN_MESSAGE);
    await main.getByRole("button", { name: "Send", exact: true }).click();
    await expect(main.getByText(SECOND_HUMAN_MESSAGE)).toBeVisible({ timeout: 30_000 });
    await expect(main.getByRole("button", { name: "Propose next action from this reply" })).toBeVisible({ timeout: 10_000 });
    await main.getByRole("button", { name: "Propose next action from this reply" }).click();
    await main.getByRole("button", { name: "Reject" }).click();
    const rejectedStatus = main.getByText(/^Rejected by /);
    await expect(rejectedStatus).toBeVisible({ timeout: 15_000 });

    // Cross-check against the plugin's own persisted data before reloading,
    // for a deterministic (non-UI-text-based) record to compare against
    // after reload.
    const before = await fetchThreadSnapshot(page.request, companyId);
    expect(before.messages).toHaveLength(4);
    expect(before.messages.filter((message) => message.role === "human")).toHaveLength(2);
    expect(before.messages.filter((message) => message.role === "companion")).toHaveLength(2);
    expect(before.proposals).toHaveLength(2);
    expect(before.proposals.map((proposal) => proposal.status).sort()).toEqual(["accepted", "rejected"]);
    expect(before.proposals.every((proposal) => Boolean(proposal.decided_by_user_id))).toBe(true);

    // 8. Reload the page and assert the same thread/messages/proposal
    // (with the same decided status) are still there.
    await page.reload();
    await expect(main.getByRole("heading", { name: "Paperclip Companion" })).toBeVisible({ timeout: 20_000 });
    // Only one thread exists for this company, so the page auto-selecting
    // "the first thread" on load is, unambiguously, re-selecting this same
    // thread — confirmed below against persisted IDs, not just UI text.
    await expect(main.getByText(HUMAN_MESSAGE)).toBeVisible({ timeout: 20_000 });
    await expect(main.getByText(SECOND_HUMAN_MESSAGE)).toBeVisible({ timeout: 20_000 });
    await expect(companionReply).toBeVisible({ timeout: 20_000 });
    await expect(main.getByText("deployment_health")).toHaveCount(2);
    await expect(decidedStatus).toBeVisible({ timeout: 20_000 });
    await expect(rejectedStatus).toBeVisible({ timeout: 20_000 });
    expect((await decidedStatus.textContent())?.trim()).toBe(decidedStatusText);

    const after = await fetchThreadSnapshot(page.request, companyId);
    expect(after.thread.id).toBe(before.thread.id);
    expect(after.messages.map((m) => m.id).sort()).toEqual(before.messages.map((m) => m.id).sort());
    expect(after.proposals).toEqual(before.proposals);
    persistedSnapshot = after;
  });

  test("soft uninstall and reinstall preserve the plugin-owned data while unregistering/re-registering UI and workers", async ({ request }) => {
    const uninstallRes = await request.delete(`/api/plugins/${PLUGIN_ID}`);
    expect(uninstallRes.ok(), `plugin uninstall failed ${uninstallRes.status()}: ${await uninstallRes.text()}`).toBe(true);
    const uninstalled = await uninstallRes.json();
    expect(uninstalled.status).toBe("uninstalled");

    const unavailableRes = await request.post(`/api/plugins/${PLUGIN_ID}/data/threads`, {
      data: { companyId, params: { companyId } },
    });
    expect(unavailableRes.status()).toBe(502);
    await expect(unavailableRes.json()).resolves.toMatchObject({ code: "WORKER_UNAVAILABLE" });

    const contributionsAfterUninstall = (await (await request.get("/api/plugins/ui-contributions")).json()) as Array<{
      pluginKey: string;
    }>;
    expect(contributionsAfterUninstall.some((item) => item.pluginKey === PLUGIN_ID)).toBe(false);

    const reinstallRes = await request.post("/api/plugins/install", {
      data: { packageName: PLUGIN_DIR, isLocalPath: true },
    });
    expect(reinstallRes.ok(), `plugin reinstall failed ${reinstallRes.status()}: ${await reinstallRes.text()}`).toBe(true);
    const reinstalled = await reinstallRes.json();
    expect(reinstalled.status).toBe("ready");

    const afterReinstall = await fetchThreadSnapshot(request, companyId);
    expect(afterReinstall).toEqual(persistedSnapshot);
  });
});
