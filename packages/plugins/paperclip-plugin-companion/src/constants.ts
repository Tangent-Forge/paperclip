export const PLUGIN_ID = "paperclipai.companion";
export const PAGE_ROUTE = "companion";

export const SLOT_IDS = {
  page: "companion-page",
  routeSidebar: "companion-route-sidebar",
} as const;

export const EXPORT_NAMES = {
  page: "CompanionPage",
} as const;

export const DATA_KEYS = {
  threads: "threads",
  thread: "thread",
  evidenceSummary: "evidence-summary",
} as const;

export const ACTION_KEYS = {
  createThread: "create-thread",
  sendMessage: "send-message",
  proposeAction: "propose-action",
  decideProposal: "decide-proposal",
} as const;

export const STREAM_CHANNELS = {
  companionReply: "companion-reply",
} as const;

export const COMPANION_ISSUE_TITLE = "Paperclip Companion (system)";

/** Sentinel author id for Companion's own persisted messages/audit entries — never a real user or agent id. */
export const COMPANION_ACTOR_ID = "companion";

export const EVIDENCE_SOURCES = {
  deploymentHealth: "deployment_health",
  github: "github",
  localArtifact: "local_artifact",
  agents: "agents",
  issues: "issues",
} as const;

export const LOCAL_FOLDER_KEYS = {
  evidence: "evidence",
} as const;
