import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkLockfile } from '../check-pr-lockfile.mjs';

const makeFiles = (filenames) => filenames.map(f => ({ filename: f, status: 'modified' }));

test('passes when lockfile is not changed', () => {
  assert.equal(checkLockfile(makeFiles(['src/foo.ts']), 'someuser', 'fix/bug').passed, true);
});

test('passes when lockfile changed by refresh bot on correct branch', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'github-actions[bot]',
    'chore/refresh-lockfile'
  );
  assert.equal(result.passed, true);
});

test('passes for a same-repository upstream-adoption branch', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'someuser',
    'sync/upstream-adoption-20260818',
    'Tangent-Forge/paperclip',
    'Tangent-Forge/paperclip'
  );
  assert.equal(result.passed, true);
});

test('fails for an upstream-adoption branch from a fork', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'someuser',
    'sync/upstream-adoption-20260818',
    'untrusted/paperclip',
    'Tangent-Forge/paperclip'
  );
  assert.equal(result.passed, false);
});

test('fails for a similarly named same-repository branch outside the reserved prefix', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'someuser',
    'sync/upstream-adoption',
    'Tangent-Forge/paperclip',
    'Tangent-Forge/paperclip'
  );
  assert.equal(result.passed, false);
});

test('fails when lockfile changed by regular user', () => {
  const result = checkLockfile(makeFiles(['pnpm-lock.yaml']), 'someuser', 'fix/bug');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('pnpm-lock.yaml'));
});

test('fails when lockfile changed by bot on wrong branch', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'github-actions[bot]',
    'fix/something-else'
  );
  assert.equal(result.passed, false);
});

test('PR workflow keeps the upstream-adoption exception same-repository and reproducible', () => {
  const workflow = readFileSync(new URL('../../workflows/pr.yml', import.meta.url), 'utf8');
  assert.match(
    workflow,
    /github\.event\.pull_request\.head\.repo\.full_name != github\.repository/
  );
  assert.match(workflow, /startsWith\(github\.head_ref, 'sync\/upstream-adoption-'\)/);
  assert.match(workflow, /git diff --quiet -- pnpm-lock\.yaml/);
});
