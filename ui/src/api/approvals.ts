import type { Approval, ApprovalComment, Issue } from "@paperclipai/shared";
import { api } from "./client";

function approvalsQueryString(params: { status?: string; unlinked?: boolean }): string {
  const search = new URLSearchParams();
  if (params.status) search.set("status", params.status);
  if (params.unlinked) search.set("unlinked", "true");
  const query = search.toString();
  return query ? `?${query}` : "";
}

export const approvalsApi = {
  list: (companyId: string, status?: string) =>
    api.get<Approval[]>(`/companies/${companyId}/approvals${approvalsQueryString({ status })}`),
  // Approvals with no linked issue — e.g. board-decision approvals routed from a stale
  // ledger ask or a blocked issue with no recorded blocker. These never appear in the
  // Issue-driven Human Decisions filter, so callers that need the full set of pending
  // human decisions (not just the ones tied to a live issue) should use this instead.
  listUnlinked: (companyId: string, status?: string) =>
    api.get<Approval[]>(`/companies/${companyId}/approvals${approvalsQueryString({ status, unlinked: true })}`),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Approval>(`/companies/${companyId}/approvals`, data),
  get: (id: string) => api.get<Approval>(`/approvals/${id}`),
  approve: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/approve`, { decisionNote }),
  reject: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/reject`, { decisionNote }),
  requestRevision: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/request-revision`, { decisionNote }),
  resubmit: (id: string, payload?: Record<string, unknown>) =>
    api.post<Approval>(`/approvals/${id}/resubmit`, { payload }),
  listComments: (id: string) => api.get<ApprovalComment[]>(`/approvals/${id}/comments`),
  addComment: (id: string, body: string) =>
    api.post<ApprovalComment>(`/approvals/${id}/comments`, { body }),
  listIssues: (id: string) => api.get<Issue[]>(`/approvals/${id}/issues`),
};
