import { z } from "zod";
import { companySearchQuerySchema } from "./search.js";

export const STATUS_CARD_AGENT_MAX_CARDS = 20;
export const STATUS_CARD_AGENT_MAX_INTEREST_PROMPT_LENGTH = 4_000;

function isValidTimeZone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export const statusCardStateSchema = z.enum(["compiling", "active", "error", "paused_budget", "paused_hours"]);
export const statusCardUpdateKindSchema = z.enum(["compile", "full", "incremental"]);
export const statusCardUpdateTriggerSchema = z.enum(["manual", "interval", "reactive", "restore"]);
export const statusCardUpdateStatusSchema = z.enum(["running", "ok", "failed"]);

export const operationalStatusSchema = z.enum(["GREEN", "YELLOW", "RED", "GRAY"]);
export const operationalReceiptStatusSchema = z.enum(["passed", "degraded", "failed"]);

export const operationalEvidenceRequirementSchema = z.object({
  sourceKey: z.string().trim().min(1).max(120),
  subjectKey: z.string().trim().min(1).max(240),
  label: z.string().trim().min(1).max(200),
}).strict();

export const operationalExceptionPolicySchema = z.object({
  states: z.array(z.enum(["YELLOW", "RED", "GRAY"])).min(1).default(["RED", "GRAY"]),
  openAfterConsecutive: z.number().int().min(1).max(100).default(2),
  resolveAfterConsecutive: z.number().int().min(1).max(100).default(1),
}).strict();

export const operationalStatusCardConfigSchema = z.object({
  requiredEvidence: z.array(operationalEvidenceRequirementSchema).min(1).max(50),
  summarizerMode: z.enum(["exceptions", "never"]).default("exceptions"),
  exceptionPolicy: operationalExceptionPolicySchema.default({}),
}).strict().superRefine((config, ctx) => {
  const keys = new Set<string>();
  config.requiredEvidence.forEach((requirement, index) => {
    const key = `${requirement.sourceKey}\u0000${requirement.subjectKey}`;
    if (keys.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiredEvidence", index],
        message: "Evidence requirements must be unique by sourceKey and subjectKey",
      });
    }
    keys.add(key);
  });
});

const operationalReceiptProvenanceSchema = z.object({
  probe: z.string().trim().min(1).max(240),
  sourceUri: z.string().trim().min(1).max(2_000).optional(),
  host: z.string().trim().min(1).max(240).optional(),
  executionId: z.string().trim().min(1).max(240).optional(),
  writerVersion: z.string().trim().min(1).max(120).optional(),
}).strict();

export const operationalReceiptObservationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("check"),
    result: operationalReceiptStatusSchema,
    detail: z.record(z.string(), z.unknown()).default({}),
  }).strict(),
  z.object({
    kind: z.literal("systemd_unit"),
    unitType: z.enum(["service", "oneshot"]),
    activeState: z.string().trim().min(1).max(80),
    subState: z.string().trim().min(1).max(80).optional(),
    result: z.string().trim().min(1).max(80),
    detail: z.record(z.string(), z.unknown()).default({}),
  }).strict(),
]);

export const ingestOperationalReceiptSchema = z.object({
  receiptId: z.string().uuid(),
  sourceKey: z.string().trim().min(1).max(120),
  subjectKey: z.string().trim().min(1).max(240),
  summary: z.string().trim().min(1).max(2_000),
  observedAt: z.string().datetime(),
  freshUntil: z.string().datetime(),
  provenance: operationalReceiptProvenanceSchema,
  observation: operationalReceiptObservationSchema,
}).strict().superRefine((receipt, ctx) => {
  if (Date.parse(receipt.freshUntil) <= Date.parse(receipt.observedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["freshUntil"],
      message: "freshUntil must be later than observedAt",
    });
  }
});

export const createOperationalStatusCardSchema = z.object({
  title: z.string().trim().min(1).max(300),
  interestPrompt: z.string().trim().min(1).max(20_000),
  agentId: z.string().uuid().nullable().optional(),
  operationalConfig: operationalStatusCardConfigSchema,
}).strict();

export const writeOperationalStatusCardSummarySchema = z.object({
  markdown: z.string().trim().min(1).max(200_000),
  changeSummary: z.string().trim().min(1).max(2_000),
  generationIssueId: z.string().uuid(),
  claimId: z.string().uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  model: z.string().trim().min(1).max(200).optional().nullable(),
}).strict();

export const statusCardRefreshTriggersSchema = z.object({
  statusTransitions: z.boolean().default(true),
  membershipChanges: z.boolean().default(true),
  humanComments: z.boolean().default(true),
  assigneeChanges: z.boolean().default(true),
  anyUpdate: z.boolean().default(false),
});

export const statusCardRefreshPolicySchema = z
  .object({
    mode: z.enum(["manual", "interval", "reactive"]).default("manual"),
    intervalMinutes: z.number().int().positive().optional(),
    debounceSeconds: z.number().int().positive().optional(),
    maxUpdatesPerHour: z.number().int().positive().optional(),
    triggers: statusCardRefreshTriggersSchema.default({}),
    activeHours: z
      .object({
        start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        timezone: z.string().trim().min(1).refine(isValidTimeZone, { message: "Invalid timezone identifier" }),
      })
      .optional(),
    dailyTokenCap: z.number().int().positive().optional(),
  })
  .superRefine((policy, ctx) => {
    if (policy.mode === "interval" && policy.intervalMinutes === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["intervalMinutes"], message: "Required for interval mode" });
    }
    if (policy.mode === "reactive" && policy.debounceSeconds === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["debounceSeconds"], message: "Required for reactive mode" });
    }
  });

export const defaultStatusCardRefreshPolicy = statusCardRefreshPolicySchema.parse({ mode: "manual" });

export const statusCardFingerprintSchema = z.record(
  z.string(),
  z.object({
    status: z.string(),
    updatedAt: z.string().datetime(),
    latestHumanCommentAt: z.string().datetime().nullable().optional(),
    identifier: z.string().nullable().optional(),
    title: z.string().optional(),
    assigneeAgentId: z.string().uuid().nullable().optional(),
    assigneeUserId: z.string().nullable().optional(),
  }),
);

export const statusCardSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  createdByUserId: z.string().nullable(),
  createdByAgentId: z.string().uuid().nullable(),
  title: z.string().nullable(),
  titlePinned: z.boolean(),
  interestPrompt: z.string(),
  queries: z.array(companySearchQuerySchema),
  queryVersion: z.number().int().nonnegative(),
  queryCompiledAt: z.string().datetime().nullable(),
  queryCompiledByAgentId: z.string().uuid().nullable(),
  agentId: z.string().uuid().nullable(),
  refreshPolicy: statusCardRefreshPolicySchema,
  state: statusCardStateSchema,
  pendingChangeCount: z.number().int().nonnegative(),
  lastChangeAt: z.string().datetime().nullable(),
  fingerprint: statusCardFingerprintSchema.nullable(),
  fingerprintAt: z.string().datetime().nullable(),
  mentionedIssueIds: z.array(z.string().uuid()).default([]),
  documentId: z.string().uuid().nullable(),
  lastUpdateRunKind: z.enum(["full", "incremental"]).nullable(),
  lastGeneratedAt: z.string().datetime().nullable(),
  lastModel: z.string().nullable(),
  generatingIssueId: z.string().uuid().nullable(),
  failureReason: z.string().nullable(),
  nextEvalAt: z.string().datetime().nullable(),
  archivedAt: z.string().datetime().nullable(),
  archivedByUserId: z.string().nullable(),
  archivedByAgentId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  kind: z.enum(["issues", "operational"]).optional(),
  operationalConfig: operationalStatusCardConfigSchema.nullable().optional(),
  operationalState: operationalStatusSchema.nullable().optional(),
  operationalFingerprint: z.string().nullable().optional(),
  operationalFailureStreak: z.number().int().nonnegative().optional(),
  operationalRecoveryStreak: z.number().int().nonnegative().optional(),
  operationalLatestClaimId: z.string().uuid().nullable().optional(),
  operationalExceptionIssueId: z.string().uuid().nullable().optional(),
  operationalSummary: z.string().nullable().optional(),
  operationalClaim: z.object({
    id: z.string().uuid(),
    state: operationalStatusSchema,
    reason: z.string(),
    fingerprint: z.string(),
    receiptIds: z.array(z.string().uuid()),
    observedAt: z.string().datetime().nullable(),
    freshUntil: z.string().datetime().nullable(),
    changed: z.boolean(),
    summaryRequired: z.boolean(),
    createdAt: z.string().datetime(),
  }).nullable().optional(),
  summaryBody: z.string().nullable().optional(),
  watchedIssueCount: z.number().int().nonnegative().optional(),
  todayTokens: z.number().int().nonnegative().optional(),
  todayCostCents: z.number().int().nonnegative().optional(),
});

export const statusCardUpdateChangeSchema = z.object({
  issueId: z.string().uuid(),
  identifier: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  changeKind: z.string(),
});

export const statusCardUpdateSchema = z.object({
  id: z.string().uuid(),
  cardId: z.string().uuid(),
  kind: statusCardUpdateKindSchema,
  trigger: statusCardUpdateTriggerSchema,
  generationIssueId: z.string().uuid().nullable(),
  runId: z.string().uuid().nullable(),
  changes: z.array(statusCardUpdateChangeSchema),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costCents: z.number().int().nonnegative(),
  model: z.string().nullable(),
  queryVersion: z.number().int().nonnegative().nullable(),
  changeSummary: z.string().nullable(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  status: statusCardUpdateStatusSchema,
  error: z.string().nullable(),
});

export const statusCardSummaryRevisionSchema = z.object({
  id: z.string().uuid(),
  revisionNumber: z.number().int().positive(),
  title: z.string().nullable(),
  body: z.string(),
  changeSummary: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const listStatusCardsQuerySchema = z.object({
  archived: z.preprocess(
    (value) => (value === "true" ? true : value === "false" ? false : value),
    z.boolean().default(false),
  ),
});

export const createStatusCardSchema = z.object({
  interestPrompt: z.string().trim().min(1).max(20_000),
  title: z.string().trim().min(1).max(300).optional(),
  titlePinned: z.boolean().default(false),
  agentId: z.string().uuid().nullable().optional(),
  refreshPolicy: statusCardRefreshPolicySchema.default(defaultStatusCardRefreshPolicy),
});

export const patchStatusCardSchema = z
  .object({
    interestPrompt: z.string().trim().min(1).max(20_000).optional(),
    title: z.string().trim().min(1).max(300).nullable().optional(),
    titlePinned: z.boolean().optional(),
    agentId: z.string().uuid().nullable().optional(),
    refreshPolicy: statusCardRefreshPolicySchema.optional(),
    archived: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const refreshStatusCardSchema = z.object({
  full: z.boolean().default(false),
});

export const writeStatusCardQuerySchema = z.object({
  queries: z.array(companySearchQuerySchema).min(1).max(10),
  title: z.string().trim().min(1).max(300),
  changeSummary: z.string().trim().min(1).max(2_000),
  generationIssueId: z.string().uuid(),
});

export const writeStatusCardSummarySchema = z.object({
  markdown: z.string().trim().min(1).max(200_000),
  title: z.string().trim().min(1).max(300).optional(),
  changeSummary: z.string().trim().min(1).max(2_000),
  generationIssueId: z.string().uuid(),
  model: z.string().trim().min(1).max(200).optional().nullable(),
});

export type StatusCard = z.infer<typeof statusCardSchema>;
export type StatusCardRefreshPolicy = z.infer<typeof statusCardRefreshPolicySchema>;
export type StatusCardUpdate = z.infer<typeof statusCardUpdateSchema>;
export type StatusCardSummaryRevision = z.infer<typeof statusCardSummaryRevisionSchema>;
export type CreateStatusCard = z.infer<typeof createStatusCardSchema>;
export type PatchStatusCard = z.infer<typeof patchStatusCardSchema>;
export type RefreshStatusCard = z.infer<typeof refreshStatusCardSchema>;
export type WriteStatusCardQuery = z.infer<typeof writeStatusCardQuerySchema>;
export type WriteStatusCardSummary = z.infer<typeof writeStatusCardSummarySchema>;
export type OperationalStatus = z.infer<typeof operationalStatusSchema>;
export type OperationalReceiptStatus = z.infer<typeof operationalReceiptStatusSchema>;
export type OperationalStatusCardConfig = z.infer<typeof operationalStatusCardConfigSchema>;
export type IngestOperationalReceipt = z.infer<typeof ingestOperationalReceiptSchema>;
export type CreateOperationalStatusCard = z.infer<typeof createOperationalStatusCardSchema>;
export type WriteOperationalStatusCardSummary = z.infer<typeof writeOperationalStatusCardSummarySchema>;
