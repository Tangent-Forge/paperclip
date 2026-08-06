import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
    AdapterEnvironmentCheck,
    AdapterEnvironmentTestContext,
    AdapterEnvironmentTestResult,
    AdapterExecutionContext,
    AdapterExecutionResult,
    ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import {
    asNumber,
    asString,
    parseObject,
    runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
export const ADAPTER_TYPE = "tf_gpu_worker";
const DEFAULT_SCRIPT = "/home/tfhub/.config/tangent-forge/agent-systems-hub/scripts/tf-worker-lane.py";
const DEFAULT_HOST = "tf-gpu-wsl";
const DEFAULT_PORT = 22;
type Config = Record<string, unknown>;
function configValue(config: Config, key: string, fallback: string): string {
    return asString(config[key], fallback).trim() || fallback;
}
function configNumber(config: Config, key: string, fallback: number): number {
    return Math.max(1, asNumber(config[key], fallback));
}
function summarize(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
    if (checks.some((check) => check.level === "error"))
        return "fail";
    if (checks.some((check) => check.level === "warn"))
        return "warn";
    return "pass";
}
function envFor(config: Config): Record<string, string> {
    return {
        TF_GPU_WORKER_HOST: configValue(config, "workerHost", DEFAULT_HOST),
        TF_GPU_WORKER_PORT: String(configNumber(config, "workerPort", DEFAULT_PORT)),
        TF_GPU_WORKER_EXPECTED_HOSTNAME: configValue(config, "expectedHostname", "TF-007"),
    };
}
function scriptFor(config: Config): string {
    return configValue(config, "hubScript", DEFAULT_SCRIPT);
}
function parseLastJson(stdout: string): Config | null {
    for (const line of stdout.trim().split(/\r?\n/).reverse()) {
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
                return parsed as Config;
        }
        catch {
            // Probe/runner diagnostics may precede the final JSON result.
        }
    }
    return null;
}
function buildJob(config: Config, context: Config, runId: string): Config {
    const configuredJob = parseObject(config.job);
    const contextJob = parseObject(context.workerJob);
    const merged: Config = { ...configuredJob, ...contextJob };
    const artifacts = Array.isArray(merged.artifacts) ? merged.artifacts : [];
    return {
        job_id: asString(merged.job_id, runId),
        job_class: asString(merged.job_class, configValue(config, "jobClass", "heavy_build")),
        source_commit: asString(merged.source_commit, asString(context.sourceCommit, "paperclip-context")),
        source_dir: asString(merged.source_dir, configValue(config, "sourceDir", "")),
        command: asString(merged.command, configValue(config, "command", "")),
        expected_outputs: merged.expected_outputs ?? [],
        resource_limits: merged.resource_limits ?? parseObject(config.resourceLimits),
        timeout_seconds: asNumber(merged.timeout_seconds, configNumber(config, "timeoutSeconds", 3600)),
        idempotency_key: asString(merged.idempotency_key, `${runId}:${asString(context.taskKey, "paperclip")}`),
        retry_policy: merged.retry_policy ?? { max_attempts: 3, backoff_seconds: 60 },
        fallback_policy: asString(merged.fallback_policy, configValue(config, "fallbackPolicy", "queue")),
        artifact_dir: asString(merged.artifact_dir, configValue(config, "artifactDir", "/home/tfhub/.local/share/tf-worker-artifacts")),
        artifacts,
    };
}
type LaneContext = Pick<AdapterExecutionContext, "runId" | "config" | "onLog">;
async function runLane(ctx: LaneContext, action: string, jobFile?: string) {
    const config = parseObject(ctx.config);
    const script = scriptFor(config);
    const args = [script, action];
    if (jobFile)
        args.push("--job-file", jobFile);
    return runChildProcess(`${ctx.runId}-${action}`, "python3", args, {
        cwd: path.dirname(script),
        env: envFor(config),
        timeoutSec: action === "probe" ? 20 : configNumber(config, "timeoutSeconds", 3600) + 30,
        graceSec: 10,
        onLog: ctx.onLog,
    });
}
export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
    const config = parseObject(ctx.config);
    const checks: AdapterEnvironmentCheck[] = [];
    const script = scriptFor(config);
    try {
        await fs.access(script);
        checks.push({ code: "tf_worker_script_present", level: "info", message: `Hub worker lane script is present: ${script}` });
    }
    catch {
        checks.push({ code: "tf_worker_script_missing", level: "error", message: "Hub worker lane script is missing.", detail: script });
    }
    if (config.enabled === false) {
        checks.push({ code: "tf_worker_disabled", level: "warn", message: "TF-007 worker lane is installed but disabled by adapter configuration." });
    }
    const fakeCtx = {
        runId: `tf-worker-env-${Date.now()}`,
        agent: { id: "environment-test", companyId: ctx.companyId, name: "environment-test", adapterType: ADAPTER_TYPE, adapterConfig: config },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config,
        context: {},
        onLog: async () => { },
    } as unknown as LaneContext;
    const probe = await runLane(fakeCtx, "probe");
    const result = parseLastJson(probe.stdout);
    if (probe.exitCode !== 0 || !result) {
        checks.push({ code: "tf_worker_probe_failed", level: "warn", message: "TF-007 is currently unreachable or probe output was invalid.", detail: "offline is an expected worker state; queued jobs remain safe" });
    }
    else {
        const state = asString(result.state, "unknown");
        const level = state === "online" ? "info" : "warn";
        checks.push({ code: "tf_worker_state", level, message: `TF-007 worker state: ${state}.`, detail: asString(result.detail, "") });
        const capabilities = parseObject(result.capabilities);
        for (const [name, value] of Object.entries(capabilities)) {
            if (typeof value === "boolean")
                checks.push({ code: `tf_worker_capability_${name}`, level: value ? "info" : "warn", message: `${name}: ${value ? "available" : "unavailable"}` });
        }
    }
    return { adapterType: ADAPTER_TYPE, status: summarize(checks), checks, testedAt: new Date().toISOString() };
}
export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    const config = parseObject(ctx.config);
    if (config.enabled === false) {
        return { exitCode: null, signal: null, timedOut: false, errorCode: "policy_denied", errorMessage: "TF-007 worker lane is disabled", resultJson: { status: "disabled" } };
    }
    const job = buildJob(config, ctx.context as Config, ctx.runId);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tf-worker-job-"));
    const jobFile = path.join(tempDir, "job.json");
    await fs.writeFile(jobFile, JSON.stringify(job, null, 2), { encoding: "utf8", mode: 0o600 });
    try {
        await ctx.onMeta?.({ adapterType: ADAPTER_TYPE, command: "tf-worker-lane.py execute", cwd: path.dirname(scriptFor(config)), commandArgs: ["--job-file", "<ephemeral>"], commandNotes: ["TF-Home-owned staged execution; TF-007 is optional worker"] });
        const proc = await runLane(ctx, "execute", jobFile);
        const result = parseLastJson(proc.stdout) ?? { status: "failed", error_code: "invalid_worker_result" };
        const status = asString(result.status, "failed");
        const sessionParams = {
            jobId: asString(result.job_id, asString(job.job_id, ctx.runId)),
            workerId: "tf-gpu-wsl",
            status,
            errorCode: asString(result.error_code, ""),
            artifacts: result.artifacts ?? [],
            updatedAt: new Date().toISOString(),
        };
        if (status === "queued") {
            return {
                exitCode: null, signal: null, timedOut: false,
                errorCode: asString(result.error_code, "worker_offline"),
                errorFamily: "transient_upstream",
                retryNotBefore: new Date(Date.now() + 60_000).toISOString(),
                errorMessage: "TF-007 is unavailable; job was durably queued on TF-Home.",
                sessionParams, sessionDisplayId: String(sessionParams.jobId), resultJson: result,
            };
        }
        return {
            exitCode: proc.exitCode,
            signal: proc.signal,
            timedOut: proc.timedOut,
            errorCode: status === "succeeded" ? null : asString(result.error_code, "job_failed"),
            errorMessage: status === "succeeded" ? null : asString(result.detail, "TF-007 worker job failed"),
            sessionParams, sessionDisplayId: String(sessionParams.jobId), resultJson: result,
        };
    }
    finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}
export const adapter: ServerAdapterModule = {
    type: ADAPTER_TYPE,
    execute,
    testEnvironment,
    models: [],
    getConfigSchema() {
        return {
            fields: [
                { key: "enabled", label: "Enabled", type: "toggle", default: false, group: "Worker policy" },
                { key: "workerHost", label: "Worker SSH host", type: "text", default: DEFAULT_HOST, group: "Worker policy" },
                { key: "workerPort", label: "Worker SSH port", type: "number", default: DEFAULT_PORT, group: "Worker policy" },
                { key: "expectedHostname", label: "Expected hostname", type: "text", default: "TF-007", group: "Worker policy" },
                { key: "hubScript", label: "Hub worker lane script", type: "text", default: DEFAULT_SCRIPT, group: "Hub execution" },
                { key: "jobClass", label: "Default job class", type: "text", default: "heavy_build", group: "Job defaults" },
                { key: "sourceDir", label: "Staged source directory", type: "text", group: "Job defaults" },
                { key: "command", label: "Worker command", type: "text", group: "Job defaults" },
                { key: "timeoutSeconds", label: "Timeout seconds", type: "number", default: 3600, group: "Job defaults" },
                { key: "artifactDir", label: "Hub artifact directory", type: "text", default: "/home/tfhub/.local/share/tf-worker-artifacts", group: "Job defaults" },
                { key: "fallbackPolicy", label: "Fallback policy", type: "text", default: "queue", group: "Worker policy" },
            ],
        };
    },
    agentConfigurationDoc: `# TF-007 bounded worker adapter

TF-Home remains canonical. This adapter stages an immutable source directory to TF-007,
executes one bounded allowlisted command, and returns checksummed artifacts. If TF-007 is
offline or degraded, the job is queued on TF-Home and Paperclip receives a retryable result.

Never put secrets in adapter config, job context, commands, or artifacts. GPU work never falls
back to TF-Home. Keep enabled=false until the TF Risk Auditor and real canary are GREEN.
`,
};
export function createServerAdapter(): ServerAdapterModule {
    return adapter;
}
