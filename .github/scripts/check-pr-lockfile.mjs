#!/usr/bin/env node
/**
 * check-pr-lockfile.mjs
 * Checks that pnpm-lock.yaml was not manually edited.
 * Export: checkLockfile(files, prAuthor, prBranch, prHeadRepo, baseRepo)
 *   → { passed, failures }
 */
import { fileURLToPath } from 'node:url';

const UPSTREAM_ADOPTION_BRANCH_PREFIX = 'sync/upstream-adoption-';

export function checkLockfile(files, prAuthor, prBranch, prHeadRepo = '', baseRepo = '') {
  const lockfileChanged = files.some(f => f.filename === 'pnpm-lock.yaml');
  if (!lockfileChanged) return { passed: true, failures: [] };

  const isRefreshBot =
    prAuthor === 'github-actions[bot]' && prBranch === 'chore/refresh-lockfile';
  const isSameRepoUpstreamAdoption =
    prHeadRepo !== '' &&
    prHeadRepo === baseRepo &&
    prBranch.startsWith(UPSTREAM_ADOPTION_BRANCH_PREFIX);
  const allowed = isRefreshBot || isSameRepoUpstreamAdoption;

  return {
    passed: allowed,
    failures: allowed ? [] : [
      'You have changes to `pnpm-lock.yaml`. Lockfile commits are limited to the refresh bot or ' +
      'same-repository `sync/upstream-adoption-*` branches, whose committed lockfile is checked ' +
      'against deterministic regeneration by `pr.yml`. For ordinary PRs, exclude the lockfile; ' +
      'the refresh bot updates it on schedule.',
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = JSON.parse(process.env.PR_FILES ?? '[]');
  const result = checkLockfile(
    files,
    process.env.PR_AUTHOR ?? '',
    process.env.PR_BRANCH ?? '',
    process.env.PR_HEAD_REPO ?? '',
    process.env.PR_BASE_REPO ?? ''
  );
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
