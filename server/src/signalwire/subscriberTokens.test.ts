import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriberTokenMinter } from './subscriberTokens.js';

describe('SubscriberTokenMinter', () => {
  it('bounds the request to SignalWire', async () => {
    // A stalled mint otherwise holds the app's POST /token for undici's
    // five-minute default.
    const minter = new SubscriberTokenMinter({
      space: 'example.signalwire.com',
      projectId: 'p',
      apiToken: 't',
      timeoutMs: 50,
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })) as unknown as typeof fetch
    });

    const started = Date.now();
    await assert.rejects(minter.mint('rn-example'));
    assert.ok(Date.now() - started < 1000);
  });
});
