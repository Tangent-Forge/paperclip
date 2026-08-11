import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@paperclipai/adapter-gemini-local/server";

async function writeFakeGeminiCommand(
  binDir: string,
  argsCapturePath: string,
  commandName = "gemini",
): Promise<string> {
  const commandPath = path.join(binDir, commandName);
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const outPath = process.env.PAPERCLIP_TEST_ARGS_PATH;
if (outPath) {
  fs.writeFileSync(outPath, JSON.stringify(process.argv.slice(2)), "utf8");
}
console.log(JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "output_text", text: "hello" }] },
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  result: "hello",
}));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

async function writeQuotaGeminiCommand(binDir: string): Promise<string> {
  const commandPath = path.join(binDir, "gemini");
  const script = `#!/usr/bin/env node
if (process.argv.includes("--help")) {
  process.exit(0);
}
console.error("429 RESOURCE_EXHAUSTED: You exceeded your current quota and billing details.");
process.exit(1);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

describe("gemini_local environment diagnostics", () => {
  it("rejects a missing absolute working directory", async () => {
    // A configured Paperclip workspace is an execution boundary, not a hint --
    // a missing directory must fail the probe rather than get silently
    // created, which could mask a workspace/configuration error as success.
    const cwd = path.join(
      os.tmpdir(),
      `paperclip-gemini-local-cwd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      "workspace",
    );

    await fs.rm(path.dirname(cwd), { recursive: true, force: true });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "gemini_local",
      config: {
        command: process.execPath,
        cwd,
      },
    });

    expect(result.checks.some((check) => check.code === "gemini_cwd_invalid")).toBe(true);
    expect(result.checks.some((check) => check.level === "error")).toBe(true);
    await expect(fs.stat(cwd)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.rm(path.dirname(cwd), { recursive: true, force: true });
  });

  it("passes agy-compatible flags to the hello probe", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-gemini-local-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const argsCapturePath = path.join(root, "args.json");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await writeFakeGeminiCommand(binDir, argsCapturePath, "agy");

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "gemini_local",
      config: {
        command: "agy",
        cwd,
        model: "gemini-2.5-pro",
        yolo: true,
        env: {
          GOOGLE_API_KEY: "test-key",
          PAPERCLIP_TEST_ARGS_PATH: argsCapturePath,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });

    expect(result.status).not.toBe("fail");
    const args = JSON.parse(await fs.readFile(argsCapturePath, "utf8")) as string[];
    expect(args).toContain("--model");
    // gemini-2.5-pro is configured; resolveGeminiLocalModel maps it onto an id agy
    // actually serves, so the resolved value is what reaches the CLI.
    expect(args).toContain("gemini-3.1-pro-low");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--disable-slash-commands");
    // agy-only since 2026-08-09: the Gemini CLI flags must never be emitted.
    expect(args).not.toContain("--approval-mode");
    expect(args).not.toContain("--skip-trust");
    expect(args).not.toContain("--sandbox=none");
    expect(args).toContain("--prompt");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("strips extraArgs attempting to override adapter-owned flags", async () => {
    // extraArgs is user/config-supplied. A configured value for a flag the
    // adapter already resolves itself (model, prompt, session, sandbox mode,
    // approval/trust flags) must never be able to override what the adapter
    // computed -- covering both "--flag value" and "--flag=value" forms.
    const root = path.join(
      os.tmpdir(),
      `paperclip-gemini-local-arg-injection-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const argsCapturePath = path.join(root, "args.json");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await writeFakeGeminiCommand(binDir, argsCapturePath, "agy");

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "gemini_local",
      config: {
        command: "agy",
        cwd,
        model: "gemini-2.5-pro",
        yolo: true,
        extraArgs: [
          "--model=evil-model",
          "--output-format=json",
          "--prompt", "override",
          "--conversation=evil-session",
          "--sandbox",
          "--custom-flag", "kept",
        ],
        env: {
          GOOGLE_API_KEY: "test-key",
          PAPERCLIP_TEST_ARGS_PATH: argsCapturePath,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });

    expect(result.status).not.toBe("fail");
    const args = JSON.parse(await fs.readFile(argsCapturePath, "utf8")) as string[];
    expect(args).not.toContain("evil-model");
    expect(args).not.toContain("--output-format=json");
    expect(args).not.toContain("override");
    expect(args).not.toContain("evil-session");
    // sandbox defaults to false in this config, so a bare --sandbox smuggled
    // through extraArgs must not survive either.
    expect(args.filter((arg) => arg === "--sandbox")).toHaveLength(0);
    expect(args).toContain("--custom-flag");
    expect(args).toContain("kept");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("classifies quota exhaustion as a quota warning instead of a generic failure", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-gemini-local-quota-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await writeQuotaGeminiCommand(binDir);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "gemini_local",
      config: {
        command: "gemini",
        cwd,
        env: {
          GOOGLE_API_KEY: "test-key",
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });

    expect(result.status).toBe("warn");
    expect(result.checks.some((check) => check.code === "gemini_hello_probe_quota_exhausted")).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("trusts remote sandbox workspaces during the hello probe", async () => {
    let probeEnv: Record<string, string> | undefined;

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "gemini_local",
      config: {
        command: "gemini",
      },
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "cloudflare",
        remoteCwd: "/workspace/paperclip",
        runner: {
          execute: async (input) => {
            if (input.command === "gemini") {
              probeEnv = input.env;
              return {
                exitCode: 0,
                signal: null,
                timedOut: false,
                stdout: [
                  JSON.stringify({
                    type: "assistant",
                    message: { content: [{ type: "output_text", text: "hello" }] },
                  }),
                  JSON.stringify({ type: "result", subtype: "success", result: "hello" }),
                ].join("\n"),
                stderr: "",
                pid: null,
                startedAt: new Date().toISOString(),
              };
            }
            return {
              exitCode: 0,
              signal: null,
              timedOut: false,
              stdout: "",
              stderr: "",
              pid: null,
              startedAt: new Date().toISOString(),
            };
          },
        },
      },
      environmentName: "QA Cloudflare",
    });

    expect(result.checks.some((check) => check.code === "gemini_hello_probe_passed")).toBe(true);
    expect(probeEnv?.GEMINI_CLI_TRUST_WORKSPACE).toBe("true");
  });
});
