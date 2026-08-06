import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BridgeTokenStore } from './BridgeTokenStore.js';

/**
 * These are the security properties of the inbound bridge flow, not
 * conveniences. A token is what stands between "the device references a parked
 * call" and "anyone holding a push payload can join someone else's call".
 */
describe('BridgeTokenStore', () => {
  it('redeems once, returning the SID the push never carried', () => {
    const store = new BridgeTokenStore();
    const { token } = store.mint('a-leg-sid', 'rn-example');

    assert.deepEqual(store.redeem(token, 'rn-example'), { callSid: 'a-leg-sid' });
  });

  it('refuses a second redemption', () => {
    // A replayed push must not bridge a second party into a live call.
    const store = new BridgeTokenStore();
    const { token } = store.mint('a-leg-sid', 'rn-example');
    store.redeem(token, 'rn-example');

    assert.deepEqual(store.redeem(token, 'rn-example'), { error: 'already-redeemed' });
  });

  it('refuses a different subscriber', () => {
    // Without this, any subscriber holding a token joins any parked call.
    const store = new BridgeTokenStore();
    const { token } = store.mint('a-leg-sid', 'rn-example');

    assert.deepEqual(store.redeem(token, 'someone-else'), { error: 'wrong-subscriber' });
  });

  it('refuses an expired token', () => {
    let now = 1_000;
    const store = new BridgeTokenStore({ ttlMs: 60_000, now: () => now });
    const { token } = store.mint('a-leg-sid', 'rn-example');

    now += 60_001;
    assert.deepEqual(store.redeem(token, 'rn-example'), { error: 'expired' });
  });

  it('reports an unknown token distinctly from a spent one', () => {
    // The difference is what tells you, from logs alone, whether a failed
    // bridge was a replay or a token that never existed.
    const store = new BridgeTokenStore();
    assert.deepEqual(store.redeem('never-minted', 'rn-example'), { error: 'unknown' });
  });

  it('keeps a spent token until expiry so replays are recognisable', () => {
    let now = 1_000;
    const store = new BridgeTokenStore({ ttlMs: 60_000, now: () => now });
    const { token } = store.mint('a-leg-sid', 'rn-example');
    store.redeem(token, 'rn-example');

    now += 30_000;
    assert.deepEqual(store.redeem(token, 'rn-example'), { error: 'already-redeemed' });
  });

  it('sweeps expired tokens rather than growing forever', () => {
    let now = 1_000;
    const store = new BridgeTokenStore({ ttlMs: 10_000, now: () => now });
    store.mint('sid-1', 'rn-example');
    store.mint('sid-2', 'rn-example');
    assert.equal(store.size, 2);

    now += 10_001;
    assert.equal(store.size, 0);
  });

  it('mints unguessable, distinct tokens', () => {
    const store = new BridgeTokenStore();
    const a = store.mint('sid-1', 'rn-example').token;
    const b = store.mint('sid-2', 'rn-example').token;

    assert.notEqual(a, b);
    assert.match(a, /^[0-9a-f-]{36}$/);
  });
});
