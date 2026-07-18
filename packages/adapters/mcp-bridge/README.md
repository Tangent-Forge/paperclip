# @tangent-forge/paperclip-mcp-adapter

Canonical TAN-23 scaffold for a Paperclip external adapter package.

## What it is

This package exposes `createServerAdapter()` for the Paperclip external adapter loader.
It currently supports only scaffolded HTTP, plugin, and process execution modes.

## Current contract

- Package name: `@tangent-forge/paperclip-mcp-adapter`
- Adapter type: `mcp_bridge`
- Entry point: built `dist/index.js` and `dist/server/index.js` after build
- Workspace/dev source: `src/index.ts` and `src/server/index.ts`
- Loader contract: `createServerAdapter()` returns the current `ServerAdapterModule` shape, including:
  - `testEnvironment`
  - optional `detectModel`

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

This is intentionally a scaffold. The mode handlers return explicit not-implemented results until the real TAN-26 bridge behavior is added.
