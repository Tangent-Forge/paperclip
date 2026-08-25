import type { ExecutionQueueDispatchResult, ExecutionQueueSummary } from "@paperclipai/shared";
import { api } from "./client";

export const executionQueueApi = {
  summary: (companyId: string) => api.get<ExecutionQueueSummary>(`/companies/${companyId}/execution-queue`),
  dispatchNext: (companyId: string) =>
    api.post<ExecutionQueueDispatchResult>(`/companies/${companyId}/execution-queue/dispatch-next`, {}),
};
