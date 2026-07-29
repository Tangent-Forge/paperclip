import path from "node:path";
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
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "executionConstraints.writeAllowlist entries must be relative POSIX paths without ..",
        path: ["executionConstraints", "writeAllowlist"],
      });
      break;
    }
  }
  for (const entry of constraints.workspaceAllowlist) {
    if (!path.isAbsolute(entry)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "executionConstraints.workspaceAllowlist entries must be absolute paths",
        path: ["executionConstraints", "workspaceAllowlist"],
      });
      break;
    }
  }
  if (constraints.network === "deny" && Boolean(value.search)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "search must be false when network is denied", path: ["search"] });
  }
  if (constraints.network === "deny" && constraints.sandboxMode === "danger-full-access") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "sandboxMode cannot be danger-full-access when network is denied",
      path: ["executionConstraints", "sandboxMode"],
    });
  }
  if (
    (constraints.profile === "canary_strict" || constraints.network === "deny" || constraints.gitMutation === "deny") &&
    (value.dangerouslyBypassApprovalsAndSandbox === true || value.dangerouslyBypassSandbox === true)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "bypass flags must be false when canary restrictions are active",
      path: ["dangerouslyBypassApprovalsAndSandbox"],
    });
  }
  if (constraints.forbidSecretEnvBindings && envValue && typeof envValue === "object" && !Array.isArray(envValue)) {
    for (const [key, envBinding] of Object.entries(envValue as Record<string, unknown>)) {
      const keyLooksSecret = /(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY)/i.test(key);
      const stringBinding = typeof envBinding === "string" ? envBinding : "";
      const plainEmptyOpenAi =
        key === "OPENAI_API_KEY" &&
        (stringBinding === "" ||
          (typeof envBinding === "object" &&
            envBinding !== null &&
            (envBinding as { type?: string; value?: string }).type === "plain" &&
            (envBinding as { value?: string }).value === ""));
      const isSecretRef =
        typeof envBinding === "object" &&
        envBinding !== null &&
        (envBinding as { type?: string }).type === "secret_ref";
      if ((keyLooksSecret && !plainEmptyOpenAi) || isSecretRef) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "secret env bindings are forbidden under execution constraints",
          path: ["env", key],
        });
        break;
      }
    }
  }
  if (constraints.profile === "canary_strict") {
    const issues: Array<[string[], string]> = [];
    if (constraints.inheritProcessEnv !== false) issues.push([["executionConstraints", "inheritProcessEnv"], "inheritProcessEnv must be false"]);
    if (constraints.forbidSecretEnvBindings !== true) issues.push([["executionConstraints", "forbidSecretEnvBindings"], "forbidSecretEnvBindings must be true"]);
    if (constraints.network !== "deny") issues.push([["executionConstraints", "network"], "network must be deny"]);
    if (constraints.gitMutation !== "deny") issues.push([["executionConstraints", "gitMutation"], "gitMutation must be deny"]);
    if (constraints.canCreateTasks !== false) issues.push([["executionConstraints", "canCreateTasks"], "canCreateTasks must be false"]);
    if (constraints.canAssignTasks !== false) issues.push([["executionConstraints", "canAssignTasks"], "canAssignTasks must be false"]);
    if (constraints.canCreateAgents !== false) issues.push([["executionConstraints", "canCreateAgents"], "canCreateAgents must be false"]);
    for (const [pathParts, message] of issues) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: pathParts });
    }
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
});

export type CreateAgent = z.infer<typeof createAgentSchema>;

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

export const createAgentKeySchema = z.object({
  name: z.string().min(1).default("default"),
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
  canAssignTasks: z.boolean(),
  trustPreset: trustPresetSchema.optional(),
  authorizationPolicy: trustAuthorizationPolicySchema.optional(),
});

export type UpdateAgentPermissions = z.infer<typeof updateAgentPermissionsSchema>;
