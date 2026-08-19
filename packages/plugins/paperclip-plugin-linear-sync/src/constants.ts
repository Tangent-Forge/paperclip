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
  portfolioInventory: "portfolio-inventory",
  reconcileWorkState: "reconcile-work-state",
} as const;
/** Sole Linear workflow state eligible for Paperclip execution admission. */
export const ADMISSION_LINEAR_STATE_NAME = "Ready for Paperclip";
export const ORIGIN_KIND_LINEAR_ISSUE = `plugin:${PLUGIN_ID}:linear-issue`;
export const ORIGIN_KIND_INCIDENT = `plugin:${PLUGIN_ID}:incident`;
