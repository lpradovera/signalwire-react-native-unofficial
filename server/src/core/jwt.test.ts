import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { decodeClaims, decodeHeader, signApnsToken, signGoogleAssertion } from './jwt.js';

const ec = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
});

const rsa = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
});

describe('signApnsToken', () => {
  const token = signApnsToken({
    teamId: 'TEAM123',
    keyId: 'KEY456',
    privateKey: ec.privateKey,
    issuedAt: 1_700_000_000
  });

  it('uses ES256 and carries the key id in the header', () => {
    assert.deepEqual(decodeHeader(token), { alg: 'ES256', kid: 'KEY456', typ: 'JWT' });
  });

  it('carries the team id as issuer', () => {
    assert.deepEqual(decodeClaims(token), { iss: 'TEAM123', iat: 1_700_000_000 });
  });

  it('produces a JOSE-format signature, not DER', () => {
    // Apple rejects DER with an unhelpful 403. P-256 raw signatures are
    // exactly 64 bytes; DER encoding is variable-length and longer.
    const signature = Buffer.from(token.split('.')[2] ?? '', 'base64url');
    assert.equal(signature.length, 64);
  });
});

describe('signGoogleAssertion', () => {
  const token = signGoogleAssertion({
    clientEmail: 'svc@project.iam.gserviceaccount.com',
    privateKey: rsa.privateKey,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    issuedAt: 1_700_000_000
  });

  it('uses RS256', () => {
    assert.equal(decodeHeader(token).alg, 'RS256');
  });

  it('targets the Google token endpoint and expires in an hour', () => {
    const claims = decodeClaims(token);
    assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
    assert.equal(claims.exp, 1_700_003_600);
  });
});
