#!/usr/bin/env node
/**
 * get-bot-token.mjs
 * Generates a short-lived GitHub installation token for the review App.
 * Reads COMMITPERCLIP_KEY env var (PEM content of private key).
 * Prints the token to stdout.
 *
 * Also exports: generateJWT(privateKey), ghFetch(path, token, options)
 * These are used by all other gate scripts.
 */
import { createPrivateKey, createSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Which App we authenticate as. The default is upstream's `commitperclip`
// (app 3718661, owned by the paperclipai org), inherited with this fork --
// but a fork can never hold that App's private key, so signing as it cannot
// work here. Tangent-Forge owns `tfrm-review` (app 4541043) for this purpose;
// the REVIEW_APP_ID / REVIEW_APP_SLUG repository variables select it.
const APP_ID = (process.env.REVIEW_APP_ID || '3718661').trim();
const APP_SLUG = (process.env.REVIEW_APP_SLUG || 'commitperclip').trim();

if (!/^\d+$/.test(APP_ID)) {
  console.error(`ERROR: REVIEW_APP_ID must be the numeric App ID, got "${APP_ID}".`);
  console.error('Find it at Settings -> Developer settings -> GitHub Apps -> your App.');
  process.exit(1);
}
const OWNER_PATTERN = /^[a-zA-Z0-9_.-]+$/;
const REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

// GitHub issues app keys as PKCS#1 ("BEGIN RSA PRIVATE KEY"), and pasting a PEM
// into a CI secret frequently escapes its newlines. Both reach OpenSSL as an
// undecodable blob and fail with the same opaque
// "error:1E08010C:DECODER routines::unsupported". Normalise here, and route
// through createPrivateKey so PKCS#1 and PKCS#8 are both accepted.
export function normalizePrivateKey(raw) {
  let key = String(raw).trim();
  // Secret stored with literal backslash-n rather than real newlines.
  if (!key.includes('\n') && key.includes('\\n')) {
    key = key.replace(/\\n/g, '\n');
  }
  // Secret stored base64-wrapped around the whole PEM.
  if (!key.includes('-----BEGIN')) {
    const decoded = Buffer.from(key, 'base64').toString('utf8');
    if (decoded.includes('-----BEGIN')) {
      key = decoded.trim();
    }
  }
  return key;
}

// Matched with full delimiters so "RSA PRIVATE KEY" can never be reported as the
// bare "PRIVATE KEY". Only labels from this fixed list are ever echoed — an
// unrecognised header is reported as a boolean, so no part of the secret's own
// content can reach the log.
const KNOWN_PEM_TYPES = [
  'ENCRYPTED PRIVATE KEY',
  'OPENSSH PRIVATE KEY',
  'RSA PRIVATE KEY',
  'EC PRIVATE KEY',
  'DSA PRIVATE KEY',
  'PRIVATE KEY',
];

/**
 * Describe the *shape* of the configured key without revealing any of it.
 *
 * Every OpenSSL rejection surfaces as the same opaque ERR_OSSL_UNSUPPORTED, so
 * three separate CI fixes were attempted by guessing at the cause. Every field
 * here is metadata — lengths, counts, booleans, and labels from KNOWN_PEM_TYPES.
 */
export function describePrivateKeyShape(raw) {
  const value = String(raw ?? '');
  const trimmed = value.trim();
  const pemType = KNOWN_PEM_TYPES.find(type => value.includes(`-----BEGIN ${type}-----`)) ?? null;
  const hasBeginLine = value.includes('-----BEGIN');

  return {
    byteLength: value.length,
    isEmpty: trimmed.length === 0,
    hasBeginLine,
    pemType,
    unrecognisedPemType: hasBeginLine && pemType === null,
    lineCount: value.split(/\r?\n/).length,
    hasRealNewlines: value.includes('\n'),
    hasEscapedNewlines: value.includes('\\n'),
    hasCarriageReturns: value.includes('\r'),
    looksEncrypted: value.includes('ENCRYPTED') || value.includes('Proc-Type:'),
    // Compact first, then require real base64 length and alphabet. Matching the
    // charset alone is not enough: ordinary prose is letters and spaces, so
    // "not a pem at all" would otherwise be reported as base64.
    looksBase64Wrapped: (() => {
      if (hasBeginLine) return false;
      const compact = trimmed.replace(/\s+/g, '');
      return compact.length >= 64 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
    })(),
    wrappedInQuotes: /^(["']).*\1$/s.test(trimmed),
  };
}

/**
 * Turn a shape into the single most specific remedy, so the log says what to do
 * rather than that something is "unsupported".
 */
export function explainPrivateKeyShape(shape) {
  if (shape.isEmpty) {
    return 'The secret is set but empty. Upload the PEM with "gh secret set REVIEW_APP_PRIVATE_KEY < key.pem".';
  }
  if (shape.wrappedInQuotes) {
    return 'The stored value is wrapped in quotes. Re-upload by redirecting the file rather than pasting: "gh secret set REVIEW_APP_PRIVATE_KEY < key.pem".';
  }
  if (shape.pemType === 'OPENSSH PRIVATE KEY') {
    return 'This is an OpenSSH-format key, which GitHub App JWT signing cannot use. Convert it: "ssh-keygen -p -m PKCS8 -f key.pem", then re-upload.';
  }
  if (shape.pemType === 'ENCRYPTED PRIVATE KEY' || shape.looksEncrypted) {
    return 'The key is passphrase-encrypted; CI cannot decrypt it. Export an unencrypted copy: "openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.unencrypted.pem", then re-upload.';
  }
  if (shape.unrecognisedPemType) {
    return `The value has a PEM header, but not one usable for App JWT signing. Download a fresh private key for the ${APP_SLUG} App and re-upload it.`;
  }
  if (shape.looksBase64Wrapped) {
    return 'The value looks base64-encoded but does not decode to a PEM. Upload the .pem file itself, not an encoding of it.';
  }
  if (!shape.hasBeginLine) {
    return 'The value has no "-----BEGIN" line, so it is not a PEM. Upload the .pem file with "gh secret set REVIEW_APP_PRIVATE_KEY < key.pem".';
  }
  if (shape.hasEscapedNewlines && !shape.hasRealNewlines) {
    return 'The PEM newlines are escaped as literal backslash-n. Re-upload by redirecting the file rather than pasting.';
  }
  if (shape.hasCarriageReturns) {
    return 'The PEM has CRLF line endings. Convert to LF ("dos2unix key.pem") and re-upload.';
  }
  if (shape.lineCount < 3) {
    return 'The PEM is a single line, so its body was flattened. Re-upload by redirecting the file rather than pasting.';
  }
  return `The PEM looks structurally intact, so it may be truncated or from a deleted App key. Generate a fresh private key for the ${APP_SLUG} App and re-upload it.`;
}

export function generateJWT(privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now - 10, exp: now + 60, iss: APP_ID };
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${header}.${body}`;

  let key;
  try {
    key = createPrivateKey(normalizePrivateKey(privateKey));
  } catch (error) {
    // Never echo the key or any fragment of it — only its shape.
    const shape = describePrivateKeyShape(privateKey);
    const facts = [
      `bytes=${shape.byteLength}`,
      `lines=${shape.lineCount}`,
      `pemType=${shape.pemType ?? (shape.hasBeginLine ? 'unrecognised' : 'none')}`,
      `realNewlines=${shape.hasRealNewlines}`,
      `escapedNewlines=${shape.hasEscapedNewlines}`,
      `crlf=${shape.hasCarriageReturns}`,
      `encrypted=${shape.looksEncrypted}`,
    ].join(' ');

    throw new Error(
      `Could not parse the ${APP_SLUG} private key (${error.code ?? error.message}).\n` +
        `  Key shape: ${facts}\n` +
        `  Fix: ${explainPrivateKeyShape(shape)}`
    );
  }

  const sig = createSign('RSA-SHA256').update(data).sign(key, 'base64url');
  return `${data}.${sig}`;
}

// Per-call timeout so a single slow/hung GitHub endpoint cannot eat the entire
// workflow budget. Overridable via options.timeoutMs for callers that need
// different bounds.
export const GH_FETCH_DEFAULT_TIMEOUT_MS = 15_000;

export async function ghFetch(path, token, options = {}) {
  const { timeoutMs = GH_FETCH_DEFAULT_TIMEOUT_MS, signal: externalSignal, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`ghFetch timeout after ${timeoutMs}ms: ${path}`)), timeoutMs);
  const abortOnExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) abortOnExternal();
    else externalSignal.addEventListener('abort', abortOnExternal, { once: true });
  }
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...fetchOptions.headers,
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub API ${fetchOptions.method ?? 'GET'} ${path} → ${res.status}: ${text}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', abortOnExternal);
  }
}

export async function resolveInstallationId(fetchInstallation, token, repo, owner) {
  if (repo) {
    if (!REPO_PATTERN.test(repo)) {
      throw new Error('ERROR: GH_REPO/GITHUB_REPOSITORY must be in owner/repo format.');
    }

    const installation = await fetchInstallation(`/repos/${repo}/installation`, token);
    return installation.id;
  }

  const installations = await fetchInstallation('/app/installations', token);
  if (!installations.length) {
    throw new Error(
      `ERROR: No installations found for ${APP_SLUG}. Install URL: https://github.com/apps/${APP_SLUG}/installations/new`
    );
  }

  if (owner) {
    if (!OWNER_PATTERN.test(owner)) {
      throw new Error('ERROR: GITHUB_REPOSITORY_OWNER must be a valid GitHub owner name.');
    }

    const match = installations.find(
      installation => installation.account?.login?.toLowerCase() === owner.toLowerCase()
    );

    if (match) {
      return match.id;
    }
  }

  if (installations.length === 1) {
    return installations[0].id;
  }

  throw new Error(
    `ERROR: Multiple ${APP_SLUG} installations found. Set GH_REPO or GITHUB_REPOSITORY so the correct installation can be selected.`
  );
}

async function main() {
  const privateKey = process.env.COMMITPERCLIP_KEY;
  if (!privateKey) {
    console.error(`ERROR: COMMITPERCLIP_KEY env var not set (private key for App ${APP_SLUG}, id ${APP_ID}).`);
    console.error(`Locally: export COMMITPERCLIP_KEY="$(cat ~/.config/${APP_SLUG}/private-key.pem)"`);
    process.exit(1);
  }

  const jwt = generateJWT(privateKey);
  const repo = process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY;
  const owner = process.env.GITHUB_REPOSITORY_OWNER ?? repo?.split('/')[0];

  const installationId = await resolveInstallationId(ghFetch, jwt, repo, owner);

  const { token } = await ghFetch(
    `/app/installations/${installationId}/access_tokens`,
    jwt,
    { method: 'POST', headers: { 'Content-Type': 'application/json' } }
  );

  if (!token) {
    console.error('ERROR: Failed to get installation token from GitHub API.');
    process.exit(1);
  }

  process.stdout.write(token);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
