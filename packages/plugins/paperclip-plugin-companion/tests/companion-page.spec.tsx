// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompanionPage } from "../src/ui/index.js";
import { installCompanionTestBridge, uninstallCompanionTestBridge, type CompanionTestBridge } from "./ui-test-harness.js";

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const THREAD_1 = "thread-1";

function thread(id = THREAD_1, title = "My conversation") {
  return { id, title, created_by_user_id: "user-1", updated_at: "2026-08-25T12:00:00.000Z" };
}

function humanMessage(id: string, body: string) {
  return { id, role: "human" as const, actor_user_id: "user-1", body, evidence: null, created_at: "2026-08-25T12:00:00.000Z" };
}

function companionMessage(id: string, body: string, evidence: unknown[] | null = null) {
  return { id, role: "companion" as const, actor_user_id: null, body, evidence, created_at: "2026-08-25T12:00:01.000Z" };
}

afterEach(() => {
  cleanup();
  uninstallCompanionTestBridge();
});

describe("CompanionPage — unauthorized state", () => {
  it("shows a sign-in prompt instead of any conversation content when no host userId is present", () => {
    const bridge = installCompanionTestBridge({ companyId: COMPANY_A, userId: null });
    bridge.setData("threads", { companyId: COMPANY_A }, { loading: false, data: [thread(THREAD_1, "Should stay hidden")], error: null });
    render(<CompanionPage />);
    expect(screen.getByText(/must be signed in as an authenticated human user/i)).toBeInTheDocument();
    // Rules of hooks require usePluginData("threads") to still be called
    // unconditionally before this early return, but its result must never
    // be rendered while unauthorized — the host, not hook-call-ordering, is
    // the real authorization boundary for the underlying data.
    expect(screen.queryByText("Should stay hidden")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new conversation/i })).not.toBeInTheDocument();
  });

  it("shows a company-selection prompt when no companyId is present", () => {
    installCompanionTestBridge({ companyId: null, userId: "user-1" });
    render(<CompanionPage />);
    expect(screen.getByText(/select a company/i)).toBeInTheDocument();
  });
});

describe("CompanionPage — loading state", () => {
  it("shows a loading indicator for the conversation list while threads are in flight", () => {
    const bridge = installCompanionTestBridge({ companyId: COMPANY_A, userId: "user-1" });
    bridge.setData("threads", { companyId: COMPANY_A }, { loading: true, data: null, error: null });
    render(<CompanionPage />);
    expect(screen.getByText(/loading…/i)).toBeInTheDocument();
  });
});

describe("CompanionPage — error state", () => {
  it("shows a distinct error message when the conversation list fails to load", () => {
    const bridge = installCompanionTestBridge({ companyId: COMPANY_A, userId: "user-1" });
    bridge.setData(
      "threads",
      { companyId: COMPANY_A },
      { loading: false, data: null, error: { code: "WORKER_ERROR", message: "boom" } },
    );
    render(<CompanionPage />);
    expect(screen.getByText(/could not load conversations/i)).toBeInTheDocument();
  });
});

describe("CompanionPage — empty state", () => {
  it("shows an empty-conversations message and an empty-thread prompt when there are no threads", () => {
    const bridge = installCompanionTestBridge({ companyId: COMPANY_A, userId: "user-1" });
    bridge.setData("threads", { companyId: COMPANY_A }, { loading: false, data: [], error: null });
    render(<CompanionPage />);
    expect(screen.getByText(/no conversations yet/i)).toBeInTheDocument();
    expect(screen.getByText(/start a new conversation/i)).toBeInTheDocument();
  });

  it("shows an empty-thread message when the active thread has no messages yet", () => {
    const bridge = installCompanionTestBridge({ companyId: COMPANY_A, userId: "user-1" });
    bridge.setData("threads", { companyId: COMPANY_A }, { loading: false, data: [thread()], error: null });
    bridge.setData(
      "thread",
      { companyId: COMPANY_A, threadId: THREAD_1 },
      { loading: false, data: { thread: thread(), messages: [], proposals: [] }, error: null },
    );
    render(<CompanionPage />);
    expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();
  });
});

describe("CompanionPage — message rendering", () => {
  it("renders human and companion messages distinctly", () => {
    const bridge = installCompanionTestBridge({ companyId: COMPANY_A, userId: "user-1" });
    bridge.setData("threads", { companyId: COMPANY_A }, { loading: false, data: [thread()], error: null });
    bridge.setData(
      "thread",
      { companyId: COMPANY_A, threadId: THREAD_1 },
      {
        loading: false,
        data: {
          thread: thread(),
          messages: [humanMessage("m1", "What commit is running?"), companionMessage("m2", "Commit abc123.")],
          proposals: [],
        },
        error: null,
      },
    );
    render(<CompanionPage />);
    expect(screen.getByText("What commit is running?")).toBeInTheDocument();
    expect(screen.getByText("Commit abc123.")).toBeInTheDocument();
    expect(screen.getByText("Companion")).toBeInTheDocument(); // the companion-message label
  });
});

describe("CompanionPage — evidence rendering", () => {
  it("renders successful and failed evidence entries with their source and summary", () => {
    const bridge = installCompanionTestBridge({ companyId: COMPANY_A, userId: "user-1" });
    bridge.setData("threads", { companyId: COMPANY_A }, { loading: false, data: [thread()], error: null });
    bridge.setData(
      "thread",
      { companyId: COMPANY_A, threadId: THREAD_1 },
      {
        loading: false,
        data: {
          thread: thread(),
          messages: [
            companionMessage("m2", "Here is what I found.", [
              { source: "deployment_health", success: true, summary: "Running commit abc123." },
              { source: "github", success: false, summary: "GitHub lookup failed.", redactedError: "not_configured" },
            ]),
          ],
          proposals: [],
        },
        error: null,
      },
    );
    render(<CompanionPage />);
    expect(screen.getByText(/Running commit abc123\./)).toBeInTheDocument();
    expect(screen.getByText(/GitHub lookup failed\./)).toBeInTheDocument();
    expect(screen.getByText(/not_configured/)).toBeInTheDocument();
  });
});

describe("CompanionPage — action proposal rendering", () => {
  it("offers a propose-action button on a companion message with no proposal yet", () => {
    const bridge = installCompanionTestBridge({ companyId: COMPANY_A, userId: "user-1" });
    bridge.setData("threads", { companyId: COMPANY_A }, { loading: false, data: [thread()], error: null });
    bridge.setData(
      "thread",
      { companyId: COMPANY_A, threadId: THREAD_1 },
      { loading: false, data: { thread: thread(), messages: [companionMessage("m2", "Reply.")], proposals: [] }, error: null },
    );
    render(<CompanionPage />);
    expect(screen.getByRole("button", { name: /propose next action from this reply/i })).toBeInTheDocument();
  });

  it("renders a pending proposal card once one exists for a message, and hides the propose button", async () => {
    const bridge = installCompanionTestBridge({ companyId: COMPANY_A, userId: "user-1" });
    bridge.setData("threads", { companyId: COMPANY_A }, { loading: false, data: [thread()], error: null });
    bridge.setData(
      "thread",
      { companyId: COMPANY_A, threadId: THREAD_1 },
      { loading: false, data: { thread: thread(), messages: [companionMessage("m2", "Reply.")], proposals: [] }, error: null },
    );
    bridge.setAction("propose-action", async () => ({
      id: "prop-1",
      message_id: "m2",
      summary: "Follow up on: Reply.",
      status: "pending",
      decided_by_user_id: null,
    }));
    render(<CompanionPage />);
    await userEvent.click(screen.getByRole("button", { name: /propose next action from this reply/i }));
    expect(await screen.findByText("Proposed action")).toBeInTheDocument();
    expect(screen.getByText(/follow up on: reply\./i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /propose next action from this reply/i })).not.toBeInTheDocument();
  });
});

describe("CompanionPage — approval/rejection state", () => {
  it("lets a human approve a pending proposal and shows the accepted state", async () => {
    const bridge = installCompanionTestBridge({ companyId: COMPANY_A, userId: "user-1" });
    bridge.setData("threads", { companyId: COMPANY_A }, { loading: false, data: [thread()], error: null });
    bridge.setData(
      "thread",
      { companyId: COMPANY_A, threadId: THREAD_1 },
      {
        loading: false,
        data: {
          thread: thread(),
          messages: [companionMessage("m2", "Reply.")],
          proposals: [{ id: "prop-1", message_id: "m2", summary: "Do the thing", status: "pending", decided_by_user_id: null }],
        },
        error: null,
      },
    );
    bridge.setAction("decide-proposal", async ({ action }: { action?: string } = {}) => ({
      id: "prop-1",
      message_id: "m2",
      summary: "Do the thing",
      status: action === "accept" ? "accepted" : "rejected",
      decided_by_user_id: "user-1",
    }));
    render(<CompanionPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^approve$/i }));
    expect(await screen.findByText(/approved by user-1/i)).toBeInTheDocument();
  });

  it("lets a human reject a pending proposal and shows the rejected state", async () => {
    const bridge = installCompanionTestBridge({ companyId: COMPANY_A, userId: "user-1" });
    bridge.setData("threads", { companyId: COMPANY_A }, { loading: false, data: [thread()], error: null });
    bridge.setData(
      "thread",
      { companyId: COMPANY_A, threadId: THREAD_1 },
      {
        loading: false,
        data: {
          thread: thread(),
          messages: [companionMessage("m2", "Reply.")],
          proposals: [{ id: "prop-1", message_id: "m2", summary: "Do the thing", status: "pending", decided_by_user_id: null }],
        },
        error: null,
      },
    );
    bridge.setAction("decide-proposal", async () => ({
      id: "prop-1",
      message_id: "m2",
      summary: "Do the thing",
      status: "rejected",
      decided_by_user_id: "user-1",
    }));
    render(<CompanionPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^reject$/i }));
    expect(await screen.findByText(/rejected by user-1/i)).toBeInTheDocument();
  });
});

describe("CompanionPage — persisted proposal visibility after reload", () => {
  it("shows an already-decided proposal from persisted thread data without any propose/decide call", () => {
    const bridge = installCompanionTestBridge({ companyId: COMPANY_A, userId: "user-1" });
    bridge.setData("threads", { companyId: COMPANY_A }, { loading: false, data: [thread()], error: null });
    // Simulates a fresh page load: the proposal already exists in the data
    // returned with the thread, as if from a prior session — nothing in
    // this render calls propose-action or decide-proposal.
    bridge.setData(
      "thread",
      { companyId: COMPANY_A, threadId: THREAD_1 },
      {
        loading: false,
        data: {
          thread: thread(),
          messages: [companionMessage("m2", "Reply.")],
          proposals: [{ id: "prop-1", message_id: "m2", summary: "Do the thing", status: "accepted", decided_by_user_id: "user-1" }],
        },
        error: null,
      },
    );
    render(<CompanionPage />);
    expect(screen.getByText("Proposed action")).toBeInTheDocument();
    expect(screen.getByText(/approved by user-1/i)).toBeInTheDocument();
    expect(bridge.actionCalls.some((c) => c.key === "propose-action" || c.key === "decide-proposal")).toBe(false);
  });
});

describe("CompanionPage — cross-company isolation", () => {
  it("only ever requests/display data scoped to the active host companyId, never another company's", () => {
    const bridgeA = installCompanionTestBridge({ companyId: COMPANY_A, userId: "user-1" });
    bridgeA.setData("threads", { companyId: COMPANY_A }, { loading: false, data: [thread(THREAD_1, "A's conversation")], error: null });
    const { unmount } = render(<CompanionPage />);
    expect(screen.getByText("A's conversation")).toBeInTheDocument();
    expect(bridgeA.dataCalls.every((c) => (c.params as { companyId?: string } | undefined)?.companyId !== COMPANY_B)).toBe(true);
    unmount();
    cleanup();
    uninstallCompanionTestBridge();

    const bridgeB = installCompanionTestBridge({ companyId: COMPANY_B, userId: "user-2" });
    bridgeB.setData("threads", { companyId: COMPANY_B }, { loading: false, data: [thread("thread-2", "B's conversation")], error: null });
    render(<CompanionPage />);
    expect(screen.queryByText("A's conversation")).not.toBeInTheDocument();
    expect(screen.getByText("B's conversation")).toBeInTheDocument();
    expect(bridgeB.dataCalls.every((c) => (c.params as { companyId?: string } | undefined)?.companyId !== COMPANY_A)).toBe(true);
  });
});

describe("CompanionPage — interrupted-response state", () => {
  it("shows a distinct interrupted state with a Retry action when sendMessage fails, not just a silent toast", async () => {
    const bridge = installCompanionTestBridge({ companyId: COMPANY_A, userId: "user-1" });
    bridge.setData("threads", { companyId: COMPANY_A }, { loading: false, data: [thread()], error: null });
    bridge.setData(
      "thread",
      { companyId: COMPANY_A, threadId: THREAD_1 },
      { loading: false, data: { thread: thread(), messages: [], proposals: [] }, error: null },
    );
    let calls = 0;
    let lastClientRequestId: string | undefined;
    bridge.setAction("send-message", async ({ clientRequestId }: { clientRequestId?: string } = {}) => {
      calls += 1;
      lastClientRequestId = clientRequestId;
      throw new Error("connection dropped");
    });
    render(<CompanionPage />);

    const composer = screen.getByPlaceholderText(/ask companion/i);
    await userEvent.type(composer, "What commit is running?");
    await userEvent.click(screen.getByRole("button", { name: /^send$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/interrupted/i);
    const retryButton = screen.getByRole("button", { name: /retry/i });
    expect(retryButton).toBeInTheDocument();
    expect(calls).toBe(1);
    const firstClientRequestId = lastClientRequestId;
    expect(firstClientRequestId).toBeTruthy();

    // Retry must reuse the same idempotency key rather than minting a new
    // one — that's what makes a retry-after-interruption safe against
    // duplicate sends server-side (see companion-service.ts sendMessage()).
    await userEvent.click(retryButton);
    await waitFor(() => expect(calls).toBe(2));
    expect(lastClientRequestId).toBe(firstClientRequestId);
  });
});
