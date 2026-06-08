export const PLUGIN_ID = "paperclipai.council-email-intake";

export const WEBHOOK_KEYS = {
  gmailRelay: "gmail-relay",
} as const;

export const API_ROUTE_KEYS = {
  intakeNow: "intake-now",
  status: "status",
} as const;

export const ORIGIN_KIND_EMAIL = `plugin:${PLUGIN_ID}:email`;
