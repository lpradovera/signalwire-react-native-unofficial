import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { BridgeTokenStore } from '../core/BridgeTokenStore.js';
import { InMemoryDeviceStore } from '../core/DeviceStore.js';
import { NotificationService } from '../core/NotificationService.js';
import { createSwmlRoutes } from './swml.js';

import type { Server } from 'node:http';
import type { Device, PushPayload, PushSender } from '../core/types.js';

const sent: Array<{ device: Device; payload: PushPayload }> = [];

const sender: PushSender = {
  platform: 'ios',
  async send(device, payload) {
    sent.push({ device, payload });
  }
};

const store = new InMemoryDeviceStore();
const tokens = new BridgeTokenStore();
const service = new NotificationService({ store, senders: [sender], uuid: () => 'fixed' });

const app = createApp({
  store,
  service,
  apiToken: 'secret',
  swmlRoutes: createSwmlRoutes({ tokens, service })
});

let server: Server;
let base: string;

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  await store.register({
    externalUserId: 'rn-example',
    platform: 'ios',
    token: 'device-token',
    environment: 'sandbox'
  });
});

after(() => server.close());

describe('POST /swml/park', () => {
  it('answers, rings, and hangs up rather than parking forever', async () => {
    sent.length = 0;
    const response = await post('/swml/park', {
      params: { call: { call_id: 'a-leg-sid', to: '/private/rn-example' } }
    });
    const swml = await response.json();

    const verbs = swml.sections.main.map((v: Record<string, unknown>) => Object.keys(v)[0]);
    assert.deepEqual(verbs, ['answer', 'play', 'hangup']);
    // A declined or unanswered call must not hold the caller indefinitely.
    assert.ok(swml.sections.main[1].play.loops > 0);
  });

  it('pushes a bridge token, never the call SID', async () => {
    sent.length = 0;
    await post('/swml/park', {
      params: { call: { call_id: 'super-secret-sid', to: '/private/rn-example' } }
    });

    const payload = sent[0]?.payload as Record<string, string>;
    assert.ok(payload.bridgeToken, 'a bridge token should be pushed');
    // The SID is a capability: it must not reach the device.
    assert.equal(
      JSON.stringify(payload).includes('super-secret-sid'),
      false,
      'the call SID must not appear anywhere in the push payload'
    );
  });

  it('is reachable without the API token, because SignalWire has none', async () => {
    const response = await post('/swml/park', {
      params: { call: { call_id: 'a-leg-sid', to: '/private/rn-example' } }
    });
    assert.equal(response.status, 200);
  });

  it('puts the real caller id on the push, from the call params', async () => {
    // With a phone number pointed at this resource, this is what shows on the
    // lock screen. Reading it from the request root instead showed "Unknown".
    sent.length = 0;
    await post('/swml/park', {
      params: {
        call: { call_id: 'a-leg-sid', to: '/public/rn-example-park', from: '+15551234567' },
        vars: { subscriber: 'rn-example' }
      }
    });

    const payload = sent[0]?.payload as Record<string, string>;
    assert.equal(payload.from, '+15551234567');
  });

  it('routes a dialled phone number to its subscriber', async () => {
    // An E.164 number names no user, so the fallback would push into the void.
    const routed = createApp({
      store,
      service,
      swmlRoutes: createSwmlRoutes({
        tokens,
        service,
        routes: { '+15551234567': 'rn-example' }
      })
    });
    const routedServer = await new Promise<Server>((resolve) => {
      const srv = routed.listen(0, () => resolve(srv));
    });
    const addr = routedServer.address();
    const routedBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

    sent.length = 0;
    await fetch(`${routedBase}/swml/park`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        params: { call: { call_id: 'a-leg-sid', to: '+15551234567', from: '+15559998888' } }
      })
    });
    routedServer.close();

    assert.equal(sent.length, 1, 'the number should route to its subscriber');
  });

  it('does not mistake the park resource for the subscriber', async () => {
    // Callers dial the park resource; its name says nothing about who to ring.
    // Resolving from it pushed to "rn-example-park" — a user that does not
    // exist — and reported delivered: 0 with no error anywhere.
    sent.length = 0;
    await post('/swml/park', {
      params: {
        call: { call_id: 'a-leg-sid', to: '/public/rn-example-park' },
        vars: { subscriber: 'rn-example' }
      }
    });

    assert.equal(sent.length, 1, 'the push should reach the real subscriber');
  });

  it('hangs up politely when the request lacks a call SID', async () => {
    const response = await post('/swml/park', { params: { call: { to: '/private/rn-example' } } });
    const swml = await response.json();
    assert.deepEqual(Object.keys(swml.sections.main[0]), ['hangup']);
  });
});

describe('POST /swml/bridge', () => {
  it('connects to the parked call using the call: prefix', async () => {
    const { token } = tokens.mint('parked-sid', 'rn-example');
    const response = await post('/swml/bridge', {
      params: { vars: { bridgeToken: token }, call: { to: '/private/rn-example' } }
    });
    const swml = await response.json();

    assert.deepEqual(swml.sections.main[0], { connect: { to: 'call:parked-sid' } });
  });

  it('hangs up instead of bridging when the token was already spent', async () => {
    const { token } = tokens.mint('parked-sid', 'rn-example');
    await post('/swml/bridge', {
      params: { vars: { bridgeToken: token }, call: { to: '/private/rn-example' } }
    });

    const replay = await post('/swml/bridge', {
      params: { vars: { bridgeToken: token }, call: { to: '/private/rn-example' } }
    });
    const swml = await replay.json();
    assert.deepEqual(Object.keys(swml.sections.main[0]), ['hangup']);
  });

  it('refuses a token belonging to another subscriber', async () => {
    const { token } = tokens.mint('parked-sid', 'rn-example');
    const response = await post('/swml/bridge', {
      params: { vars: { bridgeToken: token }, call: { to: '/private/someone-else' } }
    });
    const swml = await response.json();
    assert.deepEqual(Object.keys(swml.sections.main[0]), ['hangup']);
  });
});

describe('GET /swml/ringback', () => {
  it('serves a playable WAV, since the park script points SignalWire at it', async () => {
    const response = await fetch(`${base}/swml/ringback`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/wav');

    const buffer = Buffer.from(await response.arrayBuffer());
    assert.equal(buffer.subarray(0, 4).toString(), 'RIFF');
    assert.equal(buffer.subarray(8, 12).toString(), 'WAVE');
    // 6 seconds of 8kHz mono 16-bit, plus the 44-byte header.
    assert.equal(buffer.length, 44 + 6 * 8000 * 2);
  });
});
