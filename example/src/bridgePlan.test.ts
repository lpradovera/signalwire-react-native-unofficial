import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planBridgeAnswer } from './bridgePlan';

test('a push with a bridge token dials the bridge address with it', () => {
  assert.deepEqual(planBridgeAnswer({ bridgeToken: 'a b' }, '/private/bridge'), {
    action: 'dial',
    destination: '/private/bridge?bridgeToken=a%20b'
  });
});

// The user has already accepted the call; leaving the entry to the 60 s
// answered timeout kept an answered native call with nothing behind it on
// screen while the caller heard ringback.
test('a bridge push with no bridge address configured ends the answered call', () => {
  const plan = planBridgeAnswer({ bridgeToken: 'tok' }, undefined);
  assert.equal(plan.action, 'end');
  assert.match(plan.action === 'end' ? plan.reason : '', /EXPO_PUBLIC_SW_BRIDGE_ADDRESS/);
  assert.equal(planBridgeAnswer({ bridgeToken: 'tok' }, '').action, 'end');
});

// Without a bridge token this is not a bridge push: the inbound SDK call may
// still arrive and fuse with the answered entry, so it must stay open.
test('a push without a bridge token is left for fusion', () => {
  assert.equal(planBridgeAnswer(undefined, '/private/bridge').action, 'ignore');
  assert.equal(planBridgeAnswer({ other: 'x' }, undefined).action, 'ignore');
});
