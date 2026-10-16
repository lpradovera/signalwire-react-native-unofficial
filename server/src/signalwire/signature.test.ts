import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { isSignedBySignalWire } from './signature.js';

/**
 * Test vectors from SignalWire's own SDK documentation (signalwire-typescript
 * docs/security.md, "What Is Signed", originally from the Python SDK): the
 * JSON scheme SignalWire uses for SWML, RELAY and other JSON webhooks.
 */
const KEY = 'PSKtest1234567890abcdef';
const URL = 'https://example.ngrok.io/webhook';
const BODY = '{"event":"call.state","params":{"call_id":"abc-123","state":"answered"}}';
const SHA1 = 'c3c08c1fefaf9ee198a100d5906765a6f394bf0f';
const SHA256 = '2a29f8a92b11df39da80c3b185fd62173d49c294184da585ff951eae4433571c';

describe('isSignedBySignalWire', () => {
  it('accepts the documented SHA-1 vector (X-SignalWire-Signature)', () => {
    assert.equal(
      isSignedBySignalWire({ signingKey: KEY, url: URL, rawBody: BODY, headers: { 'x-signalwire-signature': SHA1 } }),
      true
    );
  });

  it('accepts the documented SHA-256 vector (X-SignalWire-Sha256-Signature)', () => {
    assert.equal(
      isSignedBySignalWire({
        signingKey: KEY,
        url: URL,
        rawBody: BODY,
        headers: { 'x-signalwire-sha256-signature': SHA256 }
      }),
      true
    );
  });

  it('falls back to SHA-1 when the SHA-256 header does not match', () => {
    assert.equal(
      isSignedBySignalWire({
        signingKey: KEY,
        url: URL,
        rawBody: BODY,
        headers: { 'x-signalwire-sha256-signature': '00'.repeat(32), 'x-signalwire-signature': SHA1 }
      }),
      true
    );
  });

  it('rejects a request with no signature', () => {
    assert.equal(isSignedBySignalWire({ signingKey: KEY, url: URL, rawBody: BODY, headers: {} }), false);
  });

  it('rejects a body changed after signing', () => {
    assert.equal(
      isSignedBySignalWire({
        signingKey: KEY,
        url: URL,
        rawBody: BODY.replace('abc-123', 'abc-124'),
        headers: { 'x-signalwire-signature': SHA1 }
      }),
      false
    );
  });

  it('rejects the same body signed for another URL', () => {
    // The URL carries the query string — for the status callback, the token.
    assert.equal(
      isSignedBySignalWire({
        signingKey: KEY,
        url: `${URL}?token=other`,
        rawBody: BODY,
        headers: { 'x-signalwire-signature': SHA1 }
      }),
      false
    );
  });

  it('rejects a signature made with another key', () => {
    const forged = createHmac('sha1', 'not-the-key').update(URL + BODY).digest('hex');
    assert.equal(
      isSignedBySignalWire({ signingKey: KEY, url: URL, rawBody: BODY, headers: { 'x-signalwire-signature': forged } }),
      false
    );
  });
});
