import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describePrivateKeyShape,
  explainPrivateKeyShape,
  generateJWT,
} from '../get-bot-token.mjs';

const BODY = 'MIIEowIBAAKCAQEAxyz\nabc123\ndef456';

test('describePrivateKeyShape: never echoes key material', () => {
  const secret = `-----BEGIN RSA PRIVATE KEY-----\n${BODY}\n-----END RSA PRIVATE KEY-----`;
  const shape = describePrivateKeyShape(secret);
  const serialised = JSON.stringify(shape);
  // The body must not survive into anything loggable.
  for (const line of BODY.split('\n')) {
    assert.ok(!serialised.includes(line), `shape leaked key body: ${line}`);
  }
  assert.ok(!explainPrivateKeyShape(shape).includes(BODY.split('\n')[0]));
});

test('describePrivateKeyShape: distinguishes PEM types with full delimiters', () => {
  assert.equal(
    describePrivateKeyShape('-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----').pemType,
    'RSA PRIVATE KEY',
  );
  assert.equal(
    describePrivateKeyShape('-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----').pemType,
    'PRIVATE KEY',
  );
  assert.equal(
    describePrivateKeyShape('-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----').pemType,
    'OPENSSH PRIVATE KEY',
  );
});

test('describePrivateKeyShape: reports an unknown header without echoing it', () => {
  const shape = describePrivateKeyShape('-----BEGIN WEIRD SECRET BLOB-----\nx\n-----END WEIRD SECRET BLOB-----');
  assert.equal(shape.pemType, null);
  assert.equal(shape.unrecognisedPemType, true);
  assert.ok(!JSON.stringify(shape).includes('WEIRD'));
});

test('explainPrivateKeyShape: each failure mode gets its own remedy', () => {
  const cases = [
    ['', /empty/i],
    ['"-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----"', /quotes/i],
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----', /ssh-keygen/],
    ['-----BEGIN ENCRYPTED PRIVATE KEY-----\nx\n-----END ENCRYPTED PRIVATE KEY-----', /passphrase-encrypted/i],
    ['not a pem at all', /no "-----BEGIN" line/],
    ['-----BEGIN PRIVATE KEY-----\\nx\\n-----END PRIVATE KEY-----', /escaped/i],
  ];
  const seen = new Set();
  for (const [input, pattern] of cases) {
    const message = explainPrivateKeyShape(describePrivateKeyShape(input));
    assert.match(message, pattern, `unexpected remedy for ${JSON.stringify(input.slice(0, 24))}`);
    seen.add(message);
  }
  assert.equal(seen.size, cases.length, 'remedies must be distinct per failure mode');
});

test('generateJWT: failure names the shape and a remedy, not the key', () => {
  const secret = `-----BEGIN OPENSSH PRIVATE KEY-----\n${BODY}\n-----END OPENSSH PRIVATE KEY-----`;
  assert.throws(
    () => generateJWT(secret),
    (error) => {
      assert.match(error.message, /Key shape:/);
      assert.match(error.message, /pemType=OPENSSH PRIVATE KEY/);
      assert.match(error.message, /ssh-keygen/);
      for (const line of BODY.split('\n')) {
        assert.ok(!error.message.includes(line), 'error leaked key body');
      }
      return true;
    },
  );
});
