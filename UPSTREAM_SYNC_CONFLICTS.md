# Upstream sync conflicts (2026-08-11)

`git merge --no-ff upstream/master` conflicted and was aborted, so
this branch carries no upstream changes yet -- only this report.

Resolve locally, then force-push this branch:

```bash
git fetch upstream master && git checkout chore/upstream-sync-2026-08-11-rerun-2200
git merge --no-ff upstream/master   # resolve, then commit
git push --force-with-lease origin chore/upstream-sync-2026-08-11-rerun-2200
```

## Conflicting paths (67)

- `.github/workflows/release.yml`
- `cli/src/__tests__/cloud.test.ts`
- `cli/src/adapters/registry.ts`
- `cli/src/commands/client/cloud.ts`
- `evals/README.md`
- `evals/promptfoo/prompts/heartbeat-system.txt`
- `package.json`
- `packages/adapter-utils/src/execution-target.ts`
- `packages/adapter-utils/src/server-utils.ts`
- `packages/adapters/acpx-local/src/index.ts`
- `packages/adapters/acpx-local/src/server/execute.test.ts`
- `packages/adapters/claude-local/src/server/execute.ts`
- `packages/adapters/claude-local/src/server/parse.test.ts`
- `packages/adapters/claude-local/src/server/parse.ts`
- `packages/adapters/codex-local/src/index.ts`
- `packages/adapters/codex-local/src/server/codex-args.test.ts`
- `packages/adapters/codex-local/src/server/codex-args.ts`
- `packages/adapters/codex-local/src/server/codex-home.test.ts`
- `packages/adapters/codex-local/src/server/codex-home.ts`
- `packages/adapters/codex-local/src/server/execute.ts`
- `packages/adapters/gemini-local/src/index.ts`
- `packages/adapters/gemini-local/src/server/execute.ts`
- `packages/adapters/hermes-gateway/package.json`
- `packages/db/src/migrations/meta/_journal.json`
- `packages/db/src/schema/agent_wakeup_requests.ts`
- `packages/shared/src/index.ts`
- `packages/shared/src/validators/agent.ts`
- `pnpm-lock.yaml`
- `scripts/release-package-manifest.json`
- `server/package.json`
- `server/src/__tests__/adapter-models.test.ts`
- `server/src/__tests__/adapter-registry.test.ts`
- `server/src/__tests__/gemini-local-adapter-environment.test.ts`
- `server/src/__tests__/health.test.ts`
- `server/src/__tests__/heartbeat-dependency-scheduling.test.ts`
- `server/src/__tests__/heartbeat-process-recovery.test.ts`
- `server/src/__tests__/heartbeat-workspace-session.test.ts`
- `server/src/__tests__/instrumentation.test.ts`
- `server/src/__tests__/low-trust-red-team-routes.test.ts`
- `server/src/__tests__/plugin-secrets-handler.test.ts`
- `server/src/__tests__/routines-service.test.ts`
- `server/src/__tests__/runtime-api.test.ts`
- `server/src/adapters/builtin-adapter-types.ts`
- `server/src/adapters/registry.ts`
- `server/src/app.ts`
- `server/src/routes/agents.ts`
- `server/src/routes/health.ts`
- `server/src/routes/issues.ts`
- `server/src/routes/openapi.ts`
- `server/src/runtime-api.ts`
- `server/src/services/environment-run-orchestrator.ts`
- `server/src/services/heartbeat.ts`
- `server/src/services/issues.ts`
- `server/src/services/plugin-secrets-handler.ts`
- `server/src/services/plugin-worker-manager.ts`
- `server/src/services/recovery/successful-run-handoff.ts`
- `server/src/services/run-log-store.ts`
- `server/src/services/workspace-realization.ts`
- `ui/package.json`
- `ui/src/adapters/adapter-display-registry.ts`
- `ui/src/adapters/gemini-local/index.ts`
- `ui/src/adapters/registry.ts`
- `ui/src/adapters/use-adapter-capabilities.ts`
- `ui/src/index.css`
- `ui/src/lib/inbox.ts`
- `ui/src/pages/Dashboard.tsx`
- `vitest.config.ts`
