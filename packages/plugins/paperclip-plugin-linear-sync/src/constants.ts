export const PLUGIN_ID = "paperclipai.linear-sync";
export const JOB_KEYS = {
  poll: "poll-linear-intake",
} as const;
export const WEBHOOK_KEYS = {
  linear: "linear",
} as const;
export const API_ROUTE_KEYS = {
  syncNow: "sync-now",
  status: "status",
} as const;
export const ORIGIN_KIND_LINEAR_ISSUE = `plugin:${PLUGIN_ID}:linear-issue`;
export const ORIGIN_KIND_INCIDENT = `plugin:${PLUGIN_ID}:incident`;
