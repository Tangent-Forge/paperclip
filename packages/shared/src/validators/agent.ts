import { z } from "zod";
import {
  AGENT_ICON_NAMES,
  AGENT_ROLES,
  AGENT_STATUSES,
  INBOX_MINE_ISSUE_STATUS_FILTER,
} from "../constants.js";
import { agentAdapterTypeSchema } from "../adapter-type.js";
import { envConfigSchema } from "./secret.js";
import { trustAuthorizationPolicySchema, trustPresetSchema } from "./trust-policy.js";
import { agentDesiredSkillSelectionSchema } from "./adapter-skills.js";
import { isSafeRelativeWritePath } from "../execution-constraints.js";

function isAbsoluteWorkspacePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
}

export const executionConstraintsSchema = z.object({
  profile: z.enum(["canary_strict"]).optional(),
  inheritProcessEnv: z.boolean(),
  envAllowlist: z.array(z.string().min(1)).optional(),
  forbidSecretEnvBindings: z.boolean(),
  network: z.enum(["allow", "deny"]),
  sandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
  workspaceAllowlist: z.array(z.string().min(1)).min(1),
  writeAllowlist: z.array(z.string().min(1)).min(1),
  gitMutation: z.enum(["allow", "deny"]),
  canCreateTasks: z.boolean(),
  canAssignTasks: z.boolean(),
  canCreateAgents: z.boolean(),
}).strict();

export const agentPermissionsSchema = z.object({
  canCreateAgents: z.boolean().optional().default(false),
  canAssignTasks: z.boolean().optional(),
  canCreateTasks: z.boolean().optional(),
  canCreateSkills: z.boolean().optional().default(true),
  trustPreset: trustPresetSchema.optional(),
  authorizationPolicy: trustAuthorizationPolicySchema.optional(),
}).catchall(z.unknown());

export const agentInstructionsBundleModeSchema = z.enum(["managed", "external"]);

export const updateAgentInstructionsBundleSchema = z.object({
  mode: agentInstructionsBundleModeSchema.optional(),
  rootPath: z.string().trim().min(1).nullable().optional(),
  entryFile: z.string().trim().min(1).optional(),
  clearLegacyPromptTemplate: z.boolean().optional().default(false),
});

export type UpdateAgentInstructionsBundle = z.infer<typeof updateAgentInstructionsBundleSchema>;

export const upsertAgentInstructionsFileSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
  clearLegacyPromptTemplate: z.boolean().optional().default(false),
});

export type UpsertAgentInstructionsFile = z.infer<typeof upsertAgentInstructionsFileSchema>;

const adapterConfigSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  const envValue = value.env;
  if (envValue !== undefined) {
    const parsed = envConfigSchema.safeParse(envValue);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "adapterConfig.env must be a map of valid env bindings",
        path: ["env"],
      });
    }
  }

  const constraintsValue = value.executionConstraints;
  if (constraintsValue === undefined) return;
  const parsedConstraints = executionConstraintsSchema.safeParse(constraintsValue);
  if (!parsedConstraints.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "adapterConfig.executionConstraints must match the execution constraints schema",
      path: ["executionConstraints"],
    });
    return;
  }
  const constraints = parsedConstraints.data;
  for (const entry of constraints.writeAllowlist) {
    if (!isSafeRelativeWritePath(entry)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "executionConstraints.writeAllowlist entries must be relative POSIX paths without ..", path: ["executionConstraints", "writeAllowlist"] });
      break;
    }
  }
  for (const entry of constraints.workspaceAllowlist) {
    if (!isAbsoluteWorkspacePath(entry)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "executionConstraints.workspaceAllowlist entries must be absolute paths", path: ["executionConstraints", "workspaceAllowlist"] });
      break;
    }
  }
  if (constraints.network === "deny" && Boolean(value.search)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "search must be false when network is denied", path: ["search"] });
  }
  if (constraints.network === "deny" && constraints.sandboxMode === "danger-full-access") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sandboxMode cannot be danger-full-access when network is denied", path: ["executionConstraints", "sandboxMode"] });
  }
  if (
    (constraints.profile === "canary_strict" || constraints.network === "deny" || constraints.gitMutation === "deny") &&
    (value.dangerouslyBypassApprovalsAndSandbox === true || value.dangerouslyBypassSandbox === true)
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "bypass flags must be false when canary restrictions are active", path: ["dangerouslyBypassApprovalsAndSandbox"] });
  }
  if (constraints.forbidSecretEnvBindings && envValue && typeof envValue === "object" && !Array.isArray(envValue)) {
    for (const [key, envBinding] of Object.entries(envValue as Record<string, unknown>)) {
      const keyLooksSecret = /(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY)/i.test(key);
      const stringBinding = typeof envBinding === "string" ? envBinding : "";
      const plainEmptyOpenAi = key === "OPENAI_API_KEY" &&
        (stringBinding === "" || (typeof envBinding === "object" && envBinding !== null && (envBinding as { type?: string; value?: string }).type === "plain" && (envBinding as { value?: string }).value === ""));
      const isSecretRef = typeof envBinding === "object" && envBinding !== null && (envBinding as { type?: string }).type === "secret_ref";
      if ((keyLooksSecret && !plainEmptyOpenAi) || isSecretRef) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "secret env bindings are forbidden under execution constraints", path: ["env", key] });
        break;
      }
    }
  }
  if (constraints.profile === "canary_strict") {
    const checks: Array<[string, boolean]> = [
      ["inheritProcessEnv must be false", constraints.inheritProcessEnv === false],
      ["forbidSecretEnvBindings must be true", constraints.forbidSecretEnvBindings === true],
      ["network must be deny", constraints.network === "deny"],
      ["gitMutation must be deny", constraints.gitMutation === "deny"],
      ["canCreateTasks must be false", constraints.canCreateTasks === false],
      ["canAssignTasks must be false", constraints.canAssignTasks === false],
      ["canCreateAgents must be false", constraints.canCreateAgents === false],
    ];
    for (const [message, ok] of checks) if (!ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ["executionConstraints"] });
  }
});

export const createAgentInstructionsBundleSchema = z.object({
  entryFile: z.string().trim().min(1).optional(),
  files: z.record(z.string(), z.string()).refine((files) => Object.keys(files).length > 0, {
    message: "instructionsBundle.files must contain at least one file",
  }),
});

const agentModelProfileConfigSchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().trim().min(1).optional(),
  adapterConfig: adapterConfigSchema,
}).strict();

export const agentRuntimeConfigSchema = z.object({
  modelProfiles: z.object({
    cheap: agentModelProfileConfigSchema.optional(),
  }).strict().optional(),
}).catchall(z.unknown());

export const createAgentSchema = z.object({
  name: z.string().min(1),
  role: z.enum(AGENT_ROLES).optional().default("general"),
  title: z.string().optional().nullable(),
  icon: z.enum(AGENT_ICON_NAMES).optional().nullable(),
  reportsTo: z.string().uuid().optional().nullable(),
  capabilities: z.string().optional().nullable(),
  desiredSkills: z.array(agentDesiredSkillSelectionSchema).optional(),
  adapterType: agentAdapterTypeSchema,
  adapterConfig: adapterConfigSchema.optional().default({}),
  instructionsBundle: createAgentInstructionsBundleSchema.optional(),
  runtimeConfig: agentRuntimeConfigSchema.optional().default({}),
  defaultEnvironmentId: z.string().uuid().optional().nullable(),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  permissions: agentPermissionsSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  // The optional stored-session claim from a completed Claude login session. It
  // is the non-secret `storedSessionId`; it carries no token. The agent-create
  // transaction consumes it as the one-time stored-session claim.
  storedSessionId: z.string().min(1).max(256).optional(),
  // The optional apply-existing flag. When true, the caller binds the fixed
  // Claude OAuth token reference to the owner stored value with no new login
  // round trip. The server permits the no-claim bind only for a user actor and
  // only when that owner already has a stored value. It carries no token.
  applyStoredClaudeLogin: z.boolean().optional(),
});

export type CreateAgent = z.infer<typeof createAgentSchema>;

export const builtInAgentProvisionSchema = z.object({
  adapterType: agentAdapterTypeSchema.optional(),
  adapterConfig: adapterConfigSchema.optional(),
  budgetMonthlyCents: z.number().int().nonnegative().optional(),
}).strict();

export type BuiltInAgentProvision = z.infer<typeof builtInAgentProvisionSchema>;

export const builtInAgentEmptyMutationSchema = z.object({}).strict().default({});

export type BuiltInAgentEmptyMutation = z.infer<typeof builtInAgentEmptyMutationSchema>;

export const builtInAgentResetSchema = z.object({
  resources: z.array(z.enum(["agent", "instructions", "skill", "routine"])).optional(),
}).strict().default({});

export type BuiltInAgentReset = z.infer<typeof builtInAgentResetSchema>;

export const createAgentHireSchema = createAgentSchema.extend({
  sourceIssueId: z.string().uuid().optional().nullable(),
  sourceIssueIds: z.array(z.string().uuid()).optional(),
});

export type CreateAgentHire = z.infer<typeof createAgentHireSchema>;

export const updateAgentSchema = createAgentSchema
  .omit({ permissions: true })
  .partial()
  .extend({
    permissions: z.never().optional(),
    replaceAdapterConfig: z.boolean().optional(),
    status: z.enum(AGENT_STATUSES).optional(),
    spentMonthlyCents: z.number().int().nonnegative().optional(),
  });

export type UpdateAgent = z.infer<typeof updateAgentSchema>;

export const updateAgentInstructionsPathSchema = z.object({
  path: z.string().trim().min(1).nullable(),
  adapterConfigKey: z.string().trim().min(1).optional(),
});

export type UpdateAgentInstructionsPath = z.infer<typeof updateAgentInstructionsPathSchema>;

export const taskBridgeAgentKeyScopeSchema = z.object({
  kind: z.literal("task_bridge"),
  projectId: z.string().uuid().optional().nullable(),
  projectIds: z.array(z.string().uuid()).max(50).optional(),
  parentIssueId: z.string().uuid().optional().nullable(),
  parentIssueIds: z.array(z.string().uuid()).max(50).optional(),
  allowedAssigneeAgentIds: z.array(z.string().uuid()).max(50).optional(),
}).strict().superRefine((value, ctx) => {
  const hasProjectBoundary = Boolean(value.projectId) || Boolean(value.projectIds?.length);
  const hasParentBoundary = Boolean(value.parentIssueId) || Boolean(value.parentIssueIds?.length);
  if (!hasProjectBoundary && !hasParentBoundary) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "task_bridge keys require at least one project or parent issue boundary",
      path: ["projectId"],
    });
  }
});

export const standardAgentKeyScopeSchema = z.object({
  kind: z.literal("standard"),
}).strict();

export const skillTestAgentKeyScopeSchema = z.object({
  kind: z.literal("skill_test"),
  issueId: z.string().uuid(),
}).strict();

export const agentApiKeyScopeSchema = z.union([
  standardAgentKeyScopeSchema,
  taskBridgeAgentKeyScopeSchema,
  skillTestAgentKeyScopeSchema,
]);

export type AgentApiKeyScope = z.infer<typeof agentApiKeyScopeSchema>;
export type TaskBridgeAgentKeyScope = z.infer<typeof taskBridgeAgentKeyScopeSchema>;
export type SkillTestAgentKeyScope = z.infer<typeof skillTestAgentKeyScopeSchema>;

export function normalizeAgentApiKeyScope(value: unknown): AgentApiKeyScope {
  const parsed = agentApiKeyScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : { kind: "standard" };
}

export const createAgentKeySchema = z.object({
  name: z.string().min(1).default("default"),
  scope: agentApiKeyScopeSchema.optional().default({ kind: "standard" }),
});

export type CreateAgentKey = z.infer<typeof createAgentKeySchema>;

export const agentMineInboxQuerySchema = z.object({
  userId: z.string().trim().min(1),
  status: z.string().trim().min(1).optional().default(INBOX_MINE_ISSUE_STATUS_FILTER),
});

export type AgentMineInboxQuery = z.infer<typeof agentMineInboxQuerySchema>;

export const wakeAgentSchema = z.object({
  source: z.enum(["timer", "assignment", "on_demand", "automation"]).optional().default("on_demand"),
  triggerDetail: z.enum(["manual", "ping", "callback", "system"]).optional(),
  reason: z.string().optional().nullable(),
  payload: z.record(z.string(), z.unknown()).optional().nullable(),
  idempotencyKey: z.string().optional().nullable(),
  forceFreshSession: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.boolean().optional().default(false),
  ),
});

export type WakeAgent = z.infer<typeof wakeAgentSchema>;

export const resetAgentSessionSchema = z.object({
  taskKey: z.string().min(1).optional().nullable(),
});

export type ResetAgentSession = z.infer<typeof resetAgentSessionSchema>;

export const testAdapterEnvironmentSchema = z.object({
  adapterConfig: adapterConfigSchema.optional().default({}),
  /**
   * Optional environment to run the adapter test inside. When omitted, the
   * test runs against the local Paperclip host. When provided and the
   * environment is non-local (SSH/sandbox), the test probes are executed
   * inside that environment so the result reflects real agent execution.
   */
  environmentId: z.string().uuid().optional().nullable(),
});

export type TestAdapterEnvironment = z.infer<typeof testAdapterEnvironmentSchema>;

export const updateAgentPermissionsSchema = z.object({
  canCreateAgents: z.boolean(),
  canCreateSkills: z.boolean().optional(),
  canAssignTasks: z.boolean(),
  canCreateTasks: z.boolean().optional(),
  trustPreset: trustPresetSchema.optional(),
  authorizationPolicy: trustAuthorizationPolicySchema.optional(),
});

export type UpdateAgentPermissions = z.infer<typeof updateAgentPermissionsSchema>;
