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

    const play = swml.sections.main[1].play;
    // `play` has no loop parameter. Passing one made the verb fail and drop
    // through to the hangup, disconnecting the caller the instant they were
    // answered. Repetition is repeated `urls` entries.
    assert.equal(play.loops, undefined, 'play must not carry an invalid loops field');
    assert.ok(Array.isArray(play.urls), 'repetition is expressed with a urls array');
    assert.ok(play.urls.length > 1, 'the caller should hear more than one ring');
    assert.match(play.urls[0], /^ring:[\d.]+:[a-z]{2}$/);

    // And a bounded window: nobody may be held forever.
    assert.deepEqual(Object.keys(swml.sections.main[2]), ['hangup']);
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
    // Identified by `from` — who is calling — not `to`, which is the bridge
    // resource and says nothing about the caller. Resolving from `to` sent
    // every request to a configured default, so a token minted for one
    // subscriber was rejected against another and the call was stranded.
    const { token } = tokens.mint('parked-sid', 'rn-example');
    const response = await post('/swml/bridge', {
      params: {
        vars: { userVariables: { bridgeToken: token } },
        call: { to: '/public/rn-example-bridge', from: '/private/someone-else' }
      }
    });
    const swml = await response.json();
    assert.deepEqual(Object.keys(swml.sections.main[0]), ['hangup']);
  });

  it('identifies a subscriber dialling out as a SIP URI', async () => {
    // What a device actually sends:
    //   sip:rn-android@<project>.call.signalwire.com;context=private
    // Reading only the /private/<ref> form found nothing, so the caller
    // looked unidentifiable and the subscriber check was skipped.
    const { token } = tokens.mint('parked-sid-sip', 'rn-android');
    const response = await post('/swml/bridge', {
      params: {
        vars: { userVariables: { bridgeToken: token } },
        call: { from: 'sip:rn-android@proj.call.signalwire.com;context=private' }
      }
    });
    const swml = await response.json();

    assert.deepEqual(swml.sections.main[0].connect.to, 'call:parked-sid-sip');
  });

  it('refuses a SIP caller who is not the token holder', async () => {
    const { token } = tokens.mint('parked-sid-sip2', 'rn-android');
    const response = await post('/swml/bridge', {
      params: {
        vars: { userVariables: { bridgeToken: token } },
        call: { from: 'sip:someone-else@proj.call.signalwire.com;context=private' }
      }
    });
    const swml = await response.json();

    assert.deepEqual(Object.keys(swml.sections.main[0]), ['hangup']);
  });

  it('still bridges when the caller cannot be identified', async () => {
    // The token is the capability: single-use, unguessable, short-lived.
    // Binding it to a subscriber is defence-in-depth, and is applied whenever
    // the request says who is calling — but refusing a valid token because
    // the caller was not identifiable strands the call for no security gain.
    const { token } = tokens.mint('parked-sid-anon', 'rn-example');
    const response = await post('/swml/bridge', {
      params: { vars: { userVariables: { bridgeToken: token } }, call: {} }
    });
    const swml = await response.json();

    assert.deepEqual(swml.sections.main[0].connect.to, 'call:parked-sid-anon');
  });

  it('is still single-use when the caller is unidentified', async () => {
    // Otherwise dropping the subscriber check would also drop replay
    // protection, which is the property that actually matters.
    const { token } = tokens.mint('parked-sid-replay', 'rn-example');
    const body = { params: { vars: { userVariables: { bridgeToken: token } }, call: {} } };
    await post('/swml/bridge', body);
    const replay = await post('/swml/bridge', body);
    const swml = await replay.json();

    assert.deepEqual(Object.keys(swml.sections.main[0]), ['hangup']);
  });
});

describe('POST /swml/bridge — the shape SignalWire actually sends', () => {
  it('finds the token nested under vars.userVariables', async () => {
    // Observed, not documented. A destination dialled as
    // `/public/x?bridgeToken=abc` arrives here as
    // params.vars.userVariables.bridgeToken. Reading only params.vars found
    // nothing, so the route hung up and the device's leg died with
    // cause USER_BUSY — a code that names neither the token nor the route.
    const { token } = tokens.mint('parked-sid', 'rn-example');
    const response = await post('/swml/bridge', {
      params: {
        call: { to: '/public/rn-example-bridge', from: '/private/rn-example' },
        vars: { userVariables: { bridgeToken: token } }
      }
    });
    const swml = await response.json();

    assert.deepEqual(swml.sections.main[0], { connect: { to: 'call:parked-sid' } });
  });

  it('still accepts the flat shape, so a change of shape is not fatal', async () => {
    const { token } = tokens.mint('parked-sid-2', 'rn-example');
    const response = await post('/swml/bridge', {
      params: { call: { to: '/private/rn-example' }, vars: { bridgeToken: token } }
    });
    const swml = await response.json();

    assert.deepEqual(swml.sections.main[0], { connect: { to: 'call:parked-sid-2' } });
  });
});

describe('POST /swml/bridge/status', () => {
  it('ends the caller leg when the bridge disconnects', async () => {
    // The device hanging up does not end the caller: that leg is not returned
    // to its script and is not hung up, so it stays up in silence. This is
    // driven by SignalWire rather than the app, which may be backgrounded or
    // killed at the moment of hangup.
    const ended: string[] = [];
    const withEnder = createApp({
      store,
      service,
      swmlRoutes: createSwmlRoutes({
        tokens,
        service,
        publicUrl: 'https://example.test',
        callEnder: { async end(id) { ended.push(id); return { ok: true }; } }
      })
    });
    const srv = await new Promise<Server>((resolve) => {
      const s2 = withEnder.listen(0, () => resolve(s2));
    });
    const addr = srv.address();
    const base2 = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

    const { token } = tokens.mint('caller-leg-sid', 'rn-example');
    await fetch(`${base2}/swml/bridge/status?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ params: { connect_state: 'disconnected' } })
    });
    await new Promise((r) => setTimeout(r, 20));
    srv.close();

    assert.deepEqual(ended, ['caller-leg-sid']);
  });

  it('leaves the call alone while the bridge is still connected', async () => {
    const ended: string[] = [];
    const withEnder = createApp({
      store,
      service,
      swmlRoutes: createSwmlRoutes({
        tokens,
        service,
        publicUrl: 'https://example.test',
        callEnder: { async end(id) { ended.push(id); return { ok: true }; } }
      })
    });
    const srv = await new Promise<Server>((resolve) => {
      const s2 = withEnder.listen(0, () => resolve(s2));
    });
    const addr = srv.address();
    const base2 = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

    const { token } = tokens.mint('still-live-sid', 'rn-example');
    await fetch(`${base2}/swml/bridge/status?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ params: { connect_state: 'connected' } })
    });
    await new Promise((r) => setTimeout(r, 20));
    srv.close();

    assert.deepEqual(ended, []);
  });

  it('puts a status_url on the connect, or the caller can never be ended', async () => {
    const { token } = tokens.mint('parked-sid-3', 'rn-example');
    const withUrl = createApp({
      store,
      service,
      swmlRoutes: createSwmlRoutes({ tokens, service, publicUrl: 'https://example.test' })
    });
    const srv = await new Promise<Server>((resolve) => {
      const s2 = withUrl.listen(0, () => resolve(s2));
    });
    const addr = srv.address();
    const base2 = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

    const response = await fetch(`${base2}/swml/bridge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        params: { call: { from: '/private/rn-example' }, vars: { userVariables: { bridgeToken: token } } }
      })
    });
    const swml = await response.json();
    srv.close();

    assert.match(swml.sections.main[0].connect.status_url, /\/swml\/bridge\/status\?token=/);
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
