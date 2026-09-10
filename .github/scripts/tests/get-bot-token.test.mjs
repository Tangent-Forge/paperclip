import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveInstallationId,
  normalizePrivateKey,
  describePrivateKeyShape,
  explainPrivateKeyShape,
  generateJWT,
} from '../get-bot-token.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '../get-bot-token.mjs');

// Build PEM-looking fixtures without embedding static key material in source.
function pemFence(kind, body = 'ABC') {
  const begin = '-----BEGIN ' + kind + '-----';
  const end = '-----END ' + kind + '-----';
  return begin + '\n' + body + '\n' + end;
}

function withReviewAppIdentity(fn) {
  const previousId = process.env.REVIEW_APP_ID;
  const previousSlug = process.env.REVIEW_APP_SLUG;
  process.env.REVIEW_APP_ID = '4541043';
  process.env.REVIEW_APP_SLUG = 'tfrm-review';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previousId === undefined) delete process.env.REVIEW_APP_ID;
      else process.env.REVIEW_APP_ID = previousId;
      if (previousSlug === undefined) delete process.env.REVIEW_APP_SLUG;
      else process.env.REVIEW_APP_SLUG = previousSlug;
    });
}

test('resolveInstallationId: uses the repo installation endpoint when repo context is available', async () => {
  await withReviewAppIdentity(async () => {
    const seenPaths = [];
    const installationId = await resolveInstallationId(async (path) => {
      seenPaths.push(path);
      return { id: 42 };
    }, 'jwt', 'paperclipai/paperclip', 'paperclipai');

    assert.equal(installationId, 42);
    assert.deepEqual(seenPaths, ['/repos/paperclipai/paperclip/installation']);
  });
});

test('resolveInstallationId: falls back to the matching owner installation', async () => {
  await withReviewAppIdentity(async () => {
    const installationId = await resolveInstallationId(async () => ([
      { id: 1, account: { login: 'someone-else' } },
      { id: 7, account: { login: 'PaperclipAI' } },
    ]), 'jwt', undefined, 'paperclipai');

    assert.equal(installationId, 7);
  });
});

test('resolveInstallationId: rejects ambiguous installations without repo or owner context', async () => {
  await withReviewAppIdentity(async () => {
    await assert.rejects(
      resolveInstallationId(async () => ([
        { id: 1, account: { login: 'org-one' } },
        { id: 2, account: { login: 'org-two' } },
      ]), 'jwt'),
      /Multiple .+ installations found/
    );
  });
});

test('normalizePrivateKey: expands literal backslash-n escapes', () => {
  const kind = 'RSA PRIVATE KEY';
  const raw = '-----BEGIN ' + kind + '-----\\nABC\\n-----END ' + kind + '-----';
  const normalized = normalizePrivateKey(raw);
  assert.ok(normalized.includes('\n'));
  assert.equal(normalized.includes('\\n'), false);
});

test('normalizePrivateKey: unwraps base64-wrapped PEM', () => {
  const pem = pemFence('PRIVATE KEY');
  const wrapped = Buffer.from(pem, 'utf8').toString('base64');
  assert.equal(normalizePrivateKey(wrapped), pem);
});

test('describePrivateKeyShape: flags missing PEM header without leaking content', () => {
  const marker = 'not-a-key-at-all';
  const shape = describePrivateKeyShape(marker);
  assert.equal(shape.hasBeginLine, false);
  assert.equal(shape.pemType, null);
  const advice = explainPrivateKeyShape(shape);
  assert.match(advice, /not a PEM/i);
  assert.equal(advice.includes(marker), false);
});

test('generateJWT: signs a throwaway RSA key and embeds numeric iss', () => {
  const previousId = process.env.REVIEW_APP_ID;
  const previousSlug = process.env.REVIEW_APP_SLUG;
  process.env.REVIEW_APP_ID = '4541043';
  process.env.REVIEW_APP_SLUG = 'tfrm-review';
  try {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
    const jwt = generateJWT(pem);
    const [, body] = jwt.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    assert.equal(payload.iss, '4541043');
    createPrivateKey(normalizePrivateKey(pem));
  } finally {
    if (previousId === undefined) delete process.env.REVIEW_APP_ID;
    else process.env.REVIEW_APP_ID = previousId;
    if (previousSlug === undefined) delete process.env.REVIEW_APP_SLUG;
    else process.env.REVIEW_APP_SLUG = previousSlug;
  }
});

test('generateJWT: refuses implicit App identity when REVIEW_APP_* unset', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const dir = mkdtempSync(join(tmpdir(), 'bot-token-'));
  const pemPath = join(dir, 'k.pem');
  writeFileSync(pemPath, pem);

  function run(env) {
    const code = [
      "import { readFileSync } from 'node:fs';",
      `import { generateJWT } from ${JSON.stringify(SCRIPT)};`,
      `const jwt = generateJWT(readFileSync(${JSON.stringify(pemPath)}, 'utf8'));`,
      "const body = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));",
      'process.stdout.write(String(body.iss));',
    ].join('\n');
    // Strip inherited identity so the child process sees only the env we pass.
    const base = { ...process.env };
    delete base.REVIEW_APP_ID;
    delete base.REVIEW_APP_SLUG;
    return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...base, ...env },
      encoding: 'utf8',
    });
  }

  const missing = run({ REVIEW_APP_ID: '', REVIEW_APP_SLUG: '' });
  assert.notEqual(missing.status, 0);
  assert.match(`${missing.stderr}\n${missing.stdout}`, /refusing implicit GitHub App identity/);

  const ok = run({ REVIEW_APP_ID: '4541043', REVIEW_APP_SLUG: 'tfrm-review' });
  assert.equal(ok.status, 0, ok.stderr || ok.stdout);
  assert.equal(ok.stdout.trim(), '4541043');
});

test('resolveInstallationId: refuses implicit App identity without REVIEW_APP_*', async () => {
  const previousId = process.env.REVIEW_APP_ID;
  const previousSlug = process.env.REVIEW_APP_SLUG;
  delete process.env.REVIEW_APP_ID;
  delete process.env.REVIEW_APP_SLUG;
  try {
    await assert.rejects(
      resolveInstallationId(async () => ({ id: 1 }), 'jwt', 'Tangent-Forge/paperclip', 'Tangent-Forge'),
      /refusing implicit GitHub App identity/
    );
  } finally {
    if (previousId === undefined) delete process.env.REVIEW_APP_ID;
    else process.env.REVIEW_APP_ID = previousId;
    if (previousSlug === undefined) delete process.env.REVIEW_APP_SLUG;
    else process.env.REVIEW_APP_SLUG = previousSlug;
  }
});
