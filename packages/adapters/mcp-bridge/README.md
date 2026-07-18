# @tangent-forge/paperclip-mcp-adapter

Canonical TAN-26 MCP bridge adapter for Paperclip.

## What it is

This package exposes `createServerAdapter()` for the Paperclip external adapter loader.
It supports the bridge modes `http`, `plugin`, and `process`.
Only `process` is implemented for live MCP stdio execution right now; `http` and `plugin` remain scaffolded.

## Current contract

- Package name: `@tangent-forge/paperclip-mcp-adapter`
- Adapter type: `mcp_bridge`
- Entry point: built `dist/index.js` and `dist/server/index.js` after build
- Workspace/dev source: `src/index.ts` and `src/server/index.ts`
- Loader contract: `createServerAdapter()` returns the current `ServerAdapterModule` shape, including:
  - `testEnvironment`
  - optional `detectModel`

## Process mode configuration

`mode: "process"` uses the MCP SDK stdio transport and requires:

- `command` — required non-empty executable path; no shell string parsing
- `args` — optional `string[]` passed literally
- `env` — optional `Record<string, string>` merged onto a safe inherited environment
- `cwd` — optional non-empty working directory
- `timeoutSec` — optional positive number, default `60`, max `3600`
- `toolName` — required non-empty MCP tool name
- `toolArguments` — optional plain JSON object merged into the single tool call
- `contextArgument` — optional argument name for the Paperclip task context, default `context`

Process mode behavior:

- build a bounded Paperclip task-context payload from a top-level allowlist only
- keep the outbound context to the current run / agent / runtime identifiers plus approved task fields
- redact common secret-shaped values and cap nested depth, string length, and total payload size
- connect to the target over stdio via the MCP SDK
- make exactly one MCP tool call
- relay target stderr to adapter stderr logs
- capture the MCP tool result, including `isError` responses
- sanitize returned `content` and `structuredContent` with corresponding defense-in-depth redaction and size limits
- return timeout and transport failures with stable adapter error codes
- fail closed on invalid config before any spawn attempt

Privacy and resource boundaries:

- Allowed task-context keys are `issueId`, `taskId`, `prompt`, `title`, `description`, `instructions`, `comment`, `wakeReason`, `paperclipTaskMarkdown`, `paperclipIssue`, `paperclipWake`, `paperclipWakeComment`, and `paperclipContinuationSummary`.
- Adapter config, auth/session values, secret manifests, workspace internals, and unknown top-level context keys are never included in the MCP task payload.
- Context values are limited to 4 nested levels, 24 keys per object, 24 array entries, 4,096 characters per string, and a shared 64 KiB character budget.
- MCP results are limited to 4 nested levels, 32 keys per object, 32 array entries, 8,192 characters per string, and a shared 128 KiB character budget across content and structured content.
- Sensitive-key and common Bearer/labeled-secret redaction is defense in depth, not a guarantee that arbitrary tool output is secret-free. The configured MCP target and downstream result consumers still require normal governance.

## Registration

For local testing, add a record to the adapter plugin store as an array entry that points at the package root:

```json
[
  {
    "packageName": "@tangent-forge/paperclip-mcp-adapter",
    "localPath": "/absolute/path/to/paperclip/packages/adapters/mcp-bridge",
    "type": "mcp_bridge",
    "installedAt": "2026-07-18T00:00:00.000Z"
  }
]
```

Paperclip's external adapter loader resolves the package entrypoint from the package root and loads the built artifact when the package is published or installed normally.

## Status

`process` is implemented for real MCP stdio execution.
`http` and `plugin` remain scaffolded and still return not-implemented results.
Environment checks for `process` validate config only; live target probing happens during execution.
