import { describe, expect, it } from "vitest";
import type { Agent, CompanySecret } from "@paperclipai/shared";
import {
  buildInlineMigrationSecretName,
  buildMigratedAgentEnv,
  collectInlineSecretMigrationCandidates,
  parseSecretsInclude,
  toPlainEnvValue,
} from "../commands/client/secrets.js";

function agent(partial: Partial<Agent>): Agent {
  return {
    id: "agent-12345678",
    companyId: "company-1",
    name: "Coder",
    urlKey: "coder",
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: {
      canCreateAgents: false,
    },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-04-26T00:00:00.000Z"),
    updatedAt: new Date("2026-04-26T00:00:00.000Z"),
    ...partial,
  };
}

function secret(partial: Partial<CompanySecret>): CompanySecret {
  return {
    id: "secret-1",
    companyId: "company-1",
    key: "agent_agent-12_anthropic_api_key",
    name: "agent_agent-12_anthropic_api_key",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 1,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-04-26T00:00:00.000Z"),
    updatedAt: new Date("2026-04-26T00:00:00.000Z"),
    ...partial,
  };
}

describe("secrets CLI helpers", () => {
  it("parses declaration include filters", () => {
    expect(parseSecretsInclude("agents,projects,tasks")).toEqual({
      company: false,
      agents: true,
      projects: true,
      issues: true,
      skills: false,
    });
  });

  it("detects inline sensitive env values that need migration", () => {
    const rows = collectInlineSecretMigrationCandidates(
      [
        agent({
          id: "agent-12345678",
          adapterConfig: {
            env: {
              ANTHROPIC_API_KEY: "sk-ant-test",
              GH_TOKEN: {
                type: "plain",
                value: "ghp-test",
              },
              PATH: {
                type: "plain",
                value: "/usr/bin",
              },
              OPENAI_API_KEY: {
                type: "secret_ref",
                secretId: "secret-existing",
              },
            },
          },
        }),
      ],
      [
        secret({
          id: "secret-gh-token",
          name: buildInlineMigrationSecretName("agent-12345678", "GH_TOKEN"),
        }),
      ],
    );

    expect(rows).toEqual([
      {
        agentId: "agent-12345678",
        agentName: "Coder",
        envKey: "ANTHROPIC_API_KEY",
        secretName: "agent_agent-12_anthropic_api_key",
        existingSecretId: null,
      },
      {
        agentId: "agent-12345678",
        agentName: "Coder",
        envKey: "GH_TOKEN",
        secretName: "agent_agent-12_gh_token",
        existingSecretId: "secret-gh-token",
      },
    ]);
  });

  it("builds migrated env bindings without preserving secret values", () => {
    const next = buildMigratedAgentEnv(
      {
        ANTHROPIC_API_KEY: "sk-ant-test",
        NODE_ENV: {
          type: "plain",
          value: "development",
        },
      },
      new Map([["ANTHROPIC_API_KEY", "secret-1"]]),
    );

    expect(next).toEqual({
      ANTHROPIC_API_KEY: {
        type: "secret_ref",
        secretId: "secret-1",
        version: "latest",
      },
      NODE_ENV: {
        type: "plain",
        value: "development",
      },
    });
    expect(JSON.stringify(next)).not.toContain("sk-ant-test");
  });

  it("reads only explicit plain env values", () => {
    expect(toPlainEnvValue("plain-value")).toBe("plain-value");
    expect(toPlainEnvValue({ type: "plain", value: "wrapped" })).toBe("wrapped");
    expect(toPlainEnvValue({ type: "secret_ref", secretId: "secret-1" })).toBeNull();
  });
});
