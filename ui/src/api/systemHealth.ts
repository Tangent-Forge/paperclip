import { api } from "./client";

/**
 * Host-level infrastructure health, produced out-of-band by a host monitor and exposed
 * by the server from a JSON snapshot. Field names are snake_case because they mirror the
 * on-disk snapshot format written by the monitor, not a server-side model.
 */
export interface HubHealthCheck {
  name: string;
  status: "OK" | "FAIL";
  detail: string;
  failing_minutes: number;
}

export interface HubHealth {
  checked_at: string;
  overall: "UP" | "DEGRADED";
  passing: number;
  failing: number;
  checks: HubHealthCheck[];
}

export const systemHealthApi = {
  hub: () => api.get<HubHealth>("/health/hub"),
};
