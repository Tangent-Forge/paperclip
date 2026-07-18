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

- build a bounded Paperclip task-context payload from the execution context
- connect to the target over stdio via the MCP SDK
- make exactly one MCP tool call
- relay target stderr to adapter stderr logs
- capture the MCP tool result, including `isError` responses
- return timeout and transport failures with stable adapter error codes
- fail closed on invalid config before any spawn attempt

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
