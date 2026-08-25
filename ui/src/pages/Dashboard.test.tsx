// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionQueueSummary } from "@paperclipai/shared";
import { Dashboard } from "./Dashboard";

const mockDashboardApi = vi.hoisted(() => ({ summary: vi.fn() }));
const mockExecutionQueueApi = vi.hoisted(() => ({ summary: vi.fn(), dispatchNext: vi.fn() }));
const mockActivityApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockAccessApi = vi.hoisted(() => ({ listUserDirectory: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockProjectsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", companies: [{ id: "company-1", name: "Co" }] }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openOnboarding: vi.fn() }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../api/dashboard", () => ({ dashboardApi: mockDashboardApi }));
vi.mock("../api/executionQueue", () => ({ executionQueueApi: mockExecutionQueueApi }));
vi.mock("../api/activity", () => ({ activityApi: mockActivityApi }));
vi.mock("../api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/projects", () => ({ projectsApi: mockProjectsApi }));

// Irrelevant to dispatch-disposition rendering — stubbed out so this test
// doesn't also have to satisfy their own independent query dependencies.
vi.mock("../components/ActiveAgentsPanel", () => ({
  ActiveAgentsPanel: () => null,
}));
vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function makeExecutionQueueSummary(overrides: Partial<ExecutionQueueSummary> = {}): ExecutionQueueSummary {
  return {
    companyId: "company-1",
    mode: "controlled",
    maxActiveRunsPerAgent: 1,
    generatedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    counts: { runnable: 1, waiting: 0, blocked: 0, held: 0 },
    runnable: [
      {
        issueId: "issue-1",
        identifier: "CO-1",
        title: "Runnable issue",
        status: "todo",
        priority: "high",
        assigneeAgentId: "agent-1",
        assigneeName: "Alpha",
        bucket: "runnable",
        reason: "ready",
        detail: "Ready for one controlled, issue-scoped dispatch.",
        updatedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
      },
    ],
    waiting: [],
    blocked: [],
    held: [],
    ...overrides,
  };
}

// Covers the gap the atomic-dispatch review flagged: dispatchNext's
// selection_incomplete disposition is a normal 200 response, not an error, so
// it never reached dispatchNextMutation.error — without dedicated handling it
// was indistinguishable from a silent no-op click. This proves the operator
// actually sees it, and that it clears itself once a later dispatch succeeds.
describe("Dashboard — execution queue dispatch disposition", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    mockDashboardApi.summary.mockResolvedValue({
      companyId: "company-1",
      agents: { active: 1, running: 0, paused: 0, error: 0 },
      tasks: { open: 1, inProgress: 0, blocked: 0, done: 0 },
      costs: { monthSpendCents: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 },
      pendingApprovals: 0,
      budgets: { activeIncidents: 0, pendingApprovals: 0, pausedAgents: 0, pausedProjects: 0 },
      runActivity: [],
    });
    mockExecutionQueueApi.summary.mockResolvedValue(makeExecutionQueueSummary());
    mockActivityApi.list.mockResolvedValue([]);
    mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });
    mockIssuesApi.list.mockResolvedValue([]);
    mockAgentsApi.list.mockResolvedValue([
      { id: "agent-1", companyId: "company-1", name: "Alpha", status: "active" },
    ]);
    mockProjectsApi.list.mockResolvedValue([]);
  });

  afterEach(async () => {
    const currentRoot = root;
    if (currentRoot) {
      await act(async () => {
        currentRoot.unmount();
      });
    }
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderDashboard() {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Dashboard />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
  }

  function clickDispatchNext() {
    const button = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("Dispatch next"),
    );
    expect(button).toBeDefined();
    return act(async () => {
      button!.click();
    });
  }

  it("shows a visible, distinctly-styled retryable notice when dispatch-next returns selection_incomplete", async () => {
    mockExecutionQueueApi.dispatchNext.mockResolvedValue({
      disposition: "selection_incomplete",
      issueId: null,
      runId: null,
      reason: "Examined 500 candidates without finding a dispatchable issue or exhausting the queue. Call dispatch-next again to continue.",
    });

    await renderDashboard();
    await clickDispatchNext();
    await flushReact();

    // Visible in the rendered DOM — not merely present on the resolved API
    // response object.
    expect(container.textContent).toContain("Selection incomplete");
    expect(container.textContent).toContain("Examined 500 candidates");

    // Distinct from the hard-error path: no destructive-styled message, and
    // the notice itself uses the warning (amber), not destructive, treatment.
    expect(container.querySelector(".text-destructive")).toBeNull();
    const notice = Array.from(container.querySelectorAll("p")).find((p) =>
      p.textContent?.includes("Selection incomplete"),
    );
    expect(notice?.className).toContain("amber");
  });

  it("does not show the selection_incomplete notice on a normal queued dispatch", async () => {
    mockExecutionQueueApi.dispatchNext.mockResolvedValue({
      disposition: "queued",
      issueId: "issue-1",
      runId: "run-1",
      reason: "Queued the highest-priority runnable issue.",
    });

    await renderDashboard();
    await clickDispatchNext();
    await flushReact();

    expect(container.textContent).not.toContain("Selection incomplete");
  });

  it("clears the selection_incomplete notice once a later dispatch succeeds", async () => {
    mockExecutionQueueApi.dispatchNext.mockResolvedValueOnce({
      disposition: "selection_incomplete",
      issueId: null,
      runId: null,
      reason: "Examined 500 candidates without finding a dispatchable issue or exhausting the queue. Call dispatch-next again to continue.",
    });

    await renderDashboard();
    await clickDispatchNext();
    await flushReact();
    expect(container.textContent).toContain("Selection incomplete");

    mockExecutionQueueApi.dispatchNext.mockResolvedValueOnce({
      disposition: "queued",
      issueId: "issue-1",
      runId: "run-1",
      reason: "Queued the highest-priority runnable issue.",
    });
    await clickDispatchNext();
    await flushReact();

    expect(container.textContent).not.toContain("Selection incomplete");
  });
});
