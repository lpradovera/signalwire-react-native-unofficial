import assert from 'node:assert/strict';
import { test } from 'node:test';

import { declineUrl, registerBridgeDecline } from './bridgeDecline';

type Entry = { uuid: string; data?: Record<string, string> };

/** A registry stand-in: rejectRequested$ with subscribe/unsubscribe. */
function fakeRegistry() {
  const listeners = new Set<(entry: Entry) => void>();
  return {
    subscribed: () => listeners.size,
    emit: (entry: Entry) => {
      for (const listener of [...listeners]) {
        listener(entry);
      }
    },
    rejectRequested$: {
      subscribe(listener: (entry: Entry) => void) {
        listeners.add(listener);
        return { unsubscribe: () => listeners.delete(listener) };
      }
    }
  };
}

function fakeFetch(status = 204) {
  const calls: { url: string; body: unknown }[] = [];
  const impl = (async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: JSON.parse(init?.body ?? 'null') });
    return { ok: status >= 200 && status < 300, status };
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('the decline URL is /swml/decline on the devices server, else the token server', () => {
  assert.equal(declineUrl('http://10.0.2.2:3000/devices', 'http://x/token'), 'http://10.0.2.2:3000/swml/decline');
  assert.equal(declineUrl(undefined, 'https://host.ts.net:8443/token'), 'https://host.ts.net:8443/swml/decline');
  assert.equal(declineUrl(undefined, undefined), undefined);
});

// The case this exists for: the app was killed, the push started a headless
// JS context, and the user tapped Decline on the call notification. React
// never mounts then, so a decline wired in a component (useBridgeDecline)
// never reached the server and the caller heard ringback for the whole park.
// Registered at module scope, the subscription exists before any push.
test('a declined bridge push is posted to the server without React', async () => {
  const registry = fakeRegistry();
  const { calls, impl } = fakeFetch();
  const stop = registerBridgeDecline({ registry, url: 'http://s/swml/decline', fetchImpl: impl });
  registry.emit({ uuid: 'u1', data: { bridgeToken: 'tok-1' } });
  await tick();
  stop();
  assert.deepEqual(calls, [{ url: 'http://s/swml/decline', body: { bridgeToken: 'tok-1' } }]);
});

test('a push without a bridge token is not posted (its SDK call is rejected on arrival)', async () => {
  const registry = fakeRegistry();
  const { calls, impl } = fakeFetch();
  const stop = registerBridgeDecline({ registry, url: 'http://s/swml/decline', fetchImpl: impl });
  registry.emit({ uuid: 'u2' });
  registry.emit({ uuid: 'u3', data: { other: 'x' } });
  await tick();
  stop();
  assert.deepEqual(calls, []);
});

test('no server configured: nothing is subscribed', () => {
  const registry = fakeRegistry();
  registerBridgeDecline({ registry, url: undefined, fetchImpl: fakeFetch().impl });
  assert.equal(registry.subscribed(), 0);
});

// index.js runs once per JS context, but a second registration (a fast
// refresh, a test) must not post every decline twice.
test('registering twice subscribes once; the returned function unsubscribes', async () => {
  const registry = fakeRegistry();
  const { calls, impl } = fakeFetch();
  const stop = registerBridgeDecline({ registry, url: 'http://s/swml/decline', fetchImpl: impl });
  registerBridgeDecline({ registry, url: 'http://s/swml/decline', fetchImpl: impl });
  assert.equal(registry.subscribed(), 1);
  registry.emit({ uuid: 'u4', data: { bridgeToken: 'tok-4' } });
  await tick();
  assert.equal(calls.length, 1);
  stop();
  assert.equal(registry.subscribed(), 0);
});

test('409 and 410 are quiet; any other failure is reported', async () => {
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    for (const status of [409, 410, 503]) {
      const registry = fakeRegistry();
      const stop = registerBridgeDecline({ registry, url: 'http://s/swml/decline', fetchImpl: fakeFetch(status).impl });
      registry.emit({ uuid: `s${status}`, data: { bridgeToken: 't' } });
      await tick();
      stop();
    }
  } finally {
    console.warn = original;
  }
  assert.deepEqual(warnings, [['Bridge decline failed: 503']]);
});
