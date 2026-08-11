---
title: Gemini Local
summary: Gemini CLI local adapter setup and configuration
---

The `gemini_local` adapter runs Google's Gemini CLI locally, or the compatible `agy` command. It supports session persistence, skills injection, and structured `stream-json` output parsing.

## Prerequisites

- Gemini CLI (`gemini`) or Antigravity CLI (`agy`) installed
- `GOOGLE_API_KEY` set, or local Gemini CLI / Antigravity OAuth configured

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Existing absolute working directory for the agent process. Missing directories are rejected so execution cannot fall back to an unrelated server directory. |
| `model` | string | No | Gemini model to use. Defaults to `auto`. |
| `promptTemplate` | string | No | Prompt used for all runs |
| `instructionsFilePath` | string | No | Markdown instructions file prepended to the prompt |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |
| `command` | string | No | CLI executable; defaults to `gemini`. Set to `agy` for Antigravity's CLI. |
| `sandbox` | boolean | No | Enable CLI sandbox mode. With `agy`, `--sandbox` is passed only when enabled. |

## Session Persistence

The adapter persists Gemini session IDs between heartbeats. On the next wake, it resumes the existing conversation with `--resume` for Gemini CLI or `--conversation` for `agy`, so the agent retains context.

When `command` is `agy`, legacy Gemini model IDs are translated to the closest currently supported Agy model. For example, `google/gemini-2.5-flash-lite` becomes `gemini-3.5-flash-low`; this prevents Agy from rejecting Gemini CLI model names that it does not recognize.

Session resume is cwd-aware: if the working directory changed since the last run, a fresh session starts instead.

If resume fails with an unknown session error, the adapter automatically retries with a fresh session.

## Skills Injection

The adapter symlinks Paperclip skills into the Gemini global skills directory (`~/.gemini/skills`). Existing user skills are not overwritten.

## Environment Test

Use the "Test Environment" button in the UI to validate the adapter config. It checks:

- Gemini CLI is installed and accessible
- Working directory is absolute and already available; missing directories fail the probe
- API key/auth hints (`GEMINI_API_KEY` or `GOOGLE_API_KEY`)
- A live hello probe using the selected CLI's supported flags to verify readiness
