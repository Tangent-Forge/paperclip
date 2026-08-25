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

test('resolveInstallationId: uses the repo installation endpoint when repo context is available', async () => {
  const seenPaths = [];
  const installationId = await resolveInstallationId(async (path) => {
    seenPaths.push(path);
    return { id: 42 };
  }, 'jwt', 'paperclipai/paperclip', 'paperclipai');

  assert.equal(installationId, 42);
  assert.deepEqual(seenPaths, ['/repos/paperclipai/paperclip/installation']);
});

test('resolveInstallationId: falls back to the matching owner installation', async () => {
  const installationId = await resolveInstallationId(async () => ([
    { id: 1, account: { login: 'someone-else' } },
    { id: 7, account: { login: 'PaperclipAI' } },
  ]), 'jwt', undefined, 'paperclipai');

  assert.equal(installationId, 7);
});

test('resolveInstallationId: rejects ambiguous installations without repo or owner context', async () => {
  await assert.rejects(
    resolveInstallationId(async () => ([
      { id: 1, account: { login: 'org-one' } },
      { id: 2, account: { login: 'org-two' } },
    ]), 'jwt'),
    /Multiple .+ installations found/
  );
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
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const jwt = generateJWT(pem);
  const [, body] = jwt.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  assert.equal(typeof payload.iss, 'string');
  assert.match(payload.iss, /^\d+$/);
  createPrivateKey(normalizePrivateKey(pem));
});

test('generateJWT: REVIEW_APP_ID overrides default iss in a fresh process', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const dir = mkdtempSync(join(tmpdir(), 'bot-token-'));
  const pemPath = join(dir, 'k.pem');
  writeFileSync(pemPath, pem);

  function readIss(env) {
    const code = [
      "import { readFileSync } from 'node:fs';",
      `import { generateJWT } from ${JSON.stringify(SCRIPT)};`,
      `const jwt = generateJWT(readFileSync(${JSON.stringify(pemPath)}, 'utf8'));`,
      "const body = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));",
      'process.stdout.write(String(body.iss));',
    ].join('\n');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout.trim();
  }

  assert.equal(readIss({ REVIEW_APP_ID: '', REVIEW_APP_SLUG: '' }), '3718661');
  assert.equal(readIss({ REVIEW_APP_ID: '4541043', REVIEW_APP_SLUG: 'tfrm-review' }), '4541043');
});
