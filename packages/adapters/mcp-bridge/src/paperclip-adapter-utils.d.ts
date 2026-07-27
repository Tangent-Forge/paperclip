declare module "@paperclipai/adapter-utils" {
  export interface AdapterEnvironmentCheck {
    code: string;
    level: "info" | "warn" | "error";
    message: string;
    detail?: string | null;
    hint?: string | null;
  }

  export interface AdapterEnvironmentTestContext {
    companyId: string;
    adapterType: string;
    config: Record<string, unknown>;
  }

  export interface AdapterEnvironmentTestResult {
    adapterType: string;
    status: "pass" | "warn" | "fail";
    checks: AdapterEnvironmentCheck[];
    testedAt: string;
  }

  export interface AdapterExecutionContext {
    config: Record<string, unknown>;
    onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  }

  export interface AdapterExecutionResult {
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    errorMessage?: string | null;
    errorCode?: string | null;
    errorFamily?: "transient_upstream" | null;
    summary?: string | null;
    resultJson?: Record<string, unknown> | null;
  }

  export interface AdapterModel {
    id: string;
    label: string;
  }

  export interface ServerAdapterModule {
    type: string;
    execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;
    testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult>;
    models?: AdapterModel[];
    agentConfigurationDoc?: string;
    detectModel?: () => Promise<{ model: string; provider: string; source: string; candidates?: string[] } | null>;
  }
}
