import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { BridgeTokenStore } from '../core/BridgeTokenStore.js';
import { InMemoryDeviceStore } from '../core/DeviceStore.js';
import { NotificationService } from '../core/NotificationService.js';
import { createSwmlRoutes } from './swml.js';

import type { Server } from 'node:http';
import type { Device, PushPayload, PushSender } from '../core/types.js';
import type { CallEnder } from '../signalwire/endCall.js';
import type { SwmlRouteOptions } from './swml.js';

/**
 * Who may drive the parked-caller routes, and what they may do.
 *
 * /swml/park, /swml/bridge and /swml/bridge/status sit outside the API-token
 * guard because SignalWire calls them and cannot hold that secret. These tests
 * cover what authorises them instead: SignalWire's request signature, the
 * single-use bridge token, and a subscriber the caller cannot choose.
 */

interface Swml {
  version: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sections: { main: any[] };
}

const PUBLIC_URL = 'https://push.example.test';
const SIGNING_KEY = 'PSKtest-signing-key';

const sign = (path: string, body: string): string =>
  createHmac('sha1', SIGNING_KEY).update(`${PUBLIC_URL}${path}${body}`).digest('hex');

interface Harness {
  base: string;
  sent: Array<{ device: Device; payload: PushPayload }>;
  ended: Array<{ callId: string; reason?: string }>;
  tokens: BridgeTokenStore;
  store: InMemoryDeviceStore;
  post: (path: string, body: unknown, headers?: Record<string, string>) => Promise<Response>;
  signedPost: (path: string, body: unknown) => Promise<Response>;
}

const servers: Server[] = [];
after(() => {
  for (const server of servers) {
    server.close();
  }
});

async function harness(
  options: Partial<SwmlRouteOptions> & { sender?: PushSender; noEnder?: boolean } = {}
): Promise<Harness> {
  const sent: Harness['sent'] = [];
  const ended: Harness['ended'] = [];
  const store = new InMemoryDeviceStore();
  await store.register({
    externalUserId: 'rn-example',
    platform: 'ios',
    token: 'device-token',
    environment: 'sandbox'
  });
  const sender: PushSender = options.sender ?? {
    platform: 'ios',
    async send(device, payload) {
      sent.push({ device, payload });
    }
  };
  const service = new NotificationService({ store, senders: [sender] });
  const tokens = options.tokens ?? new BridgeTokenStore();
  const callEnder: CallEnder | undefined = options.noEnder
    ? undefined
    : {
        async end(callId, reason) {
          ended.push({ callId, reason });
          return { ok: true };
        }
      };
  const { sender: _sender, noEnder: _noEnder, ...swmlOptions } = options;
  const app = createApp({
    store,
    service,
    apiToken: 'secret',
    swmlRoutes: createSwmlRoutes({ tokens, service, callEnder, ...swmlOptions })
  });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    });
  const signedPost = (path: string, body: unknown) => {
    const raw = JSON.stringify(body);
    return post(path, raw, { 'x-signalwire-signature': sign(path, raw) });
  };

  return { base, sent, ended, tokens, store, post, signedPost };
}

const swmlOf = async (response: Response): Promise<Swml> => (await response.json()) as Swml;
const verbs = (swml: Swml): string[] => swml.sections.main.map((verb) => Object.keys(verb)[0] ?? '');
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const parkBody = (extra: Record<string, unknown> = {}) => ({
  params: {
    call: { call_id: 'a-leg-sid', to: '/public/rn-example-park', from: '+15551234567' },
    ...extra
  }
});

describe('SignalWire signatures on the SWML routes', () => {
  const signed = { signingKey: SIGNING_KEY, publicUrl: PUBLIC_URL };

  it('refuses an unsigned park, so nobody else can ring a subscriber', async () => {
    const h = await harness({ ...signed, routes: { '/public/rn-example-park': 'rn-example' } });
    const response = await h.post('/swml/park', parkBody());

    assert.equal(response.status, 403);
    assert.equal(h.sent.length, 0, 'no push for an unsigned request');
  });

  it('refuses a park signed with another key', async () => {
    const h = await harness({ ...signed, routes: { '/public/rn-example-park': 'rn-example' } });
    const raw = JSON.stringify(parkBody());
    const forged = createHmac('sha1', 'wrong').update(`${PUBLIC_URL}/swml/park${raw}`).digest('hex');
    const response = await h.post('/swml/park', raw, { 'x-signalwire-signature': forged });

    assert.equal(response.status, 403);
    assert.equal(h.sent.length, 0);
  });

  it('parks a signed request, verified against the public URL and raw body', async () => {
    const h = await harness({ ...signed, routes: { '/public/rn-example-park': 'rn-example' } });
    const response = await h.signedPost('/swml/park', parkBody());

    assert.equal(response.status, 200);
    // With PUBLIC_URL set the park polls for its own end (see "a park that ends itself").
    assert.deepEqual(verbs(await swmlOf(response)), ['answer', 'label', 'play', 'request', 'switch', 'goto', 'hangup']);
    assert.equal(h.sent.length, 1);
  });

  it('accepts the SHA-256 header as well', async () => {
    const h = await harness({ ...signed, routes: { '/public/rn-example-park': 'rn-example' } });
    const raw = JSON.stringify(parkBody());
    const sha256 = createHmac('sha256', SIGNING_KEY).update(`${PUBLIC_URL}/swml/park${raw}`).digest('hex');
    const response = await h.post('/swml/park', raw, { 'x-signalwire-sha256-signature': sha256 });

    assert.equal(response.status, 200);
  });

  it('refuses an unsigned bridge, which would otherwise spend a token', async () => {
    const h = await harness(signed);
    const { token } = h.tokens.mint('parked-sid', 'rn-example');
    const response = await h.post('/swml/bridge', {
      params: { vars: { userVariables: { bridgeToken: token } }, call: { from: '/private/rn-example' } }
    });

    assert.equal(response.status, 403);
    // Still redeemable by the real, signed bridge.
    const real = await h.signedPost('/swml/bridge', {
      params: { vars: { userVariables: { bridgeToken: token } }, call: { from: '/private/rn-example' } }
    });
    assert.equal((await swmlOf(real)).sections.main[0].connect.to, 'call:parked-sid');
  });

  it('refuses an unsigned status callback, so a token holder cannot end the caller', async () => {
    const h = await harness(signed);
    const { token } = h.tokens.mint('parked-sid', 'rn-example');
    h.tokens.redeem(token, 'rn-example');

    const path = `/swml/bridge/status?token=${token}`;
    const response = await h.post(path, { params: { connect_state: 'failed' } });
    await settle();

    assert.equal(response.status, 403);
    assert.equal(h.ended.length, 0);

    // The same callback signed by SignalWire, query string included, works.
    const signedResponse = await h.signedPost(path, { params: { connect_state: 'disconnected' } });
    await settle();
    assert.equal(signedResponse.status, 204);
    assert.deepEqual(h.ended.map((end) => end.callId), ['parked-sid']);
  });

  it('still serves the ringback, which SignalWire fetches with GET', async () => {
    const h = await harness(signed);
    const response = await fetch(`${h.base}/swml/ringback`);
    assert.equal(response.status, 200);
  });

  it('refuses to build signature checks without the public URL they cover', () => {
    assert.throws(
      () =>
        createSwmlRoutes({
          tokens: new BridgeTokenStore(),
          service: new NotificationService({ store: new InMemoryDeviceStore(), senders: [] }),
          signingKey: SIGNING_KEY
        }),
      /PUBLIC_URL/
    );
  });
});

describe('who a park rings', () => {
  it('ignores a subscriber the caller put on the dialled address', async () => {
    // A caller dialling `/public/rn-example-park?subscriber=victim` has the
    // query copied into userVariables. Taking the subscriber from there let
    // any caller ring any user, with a signature on the request or not.
    const h = await harness({ routes: { '/public/rn-example-park': 'rn-example' } });
    await h.store.register({
      externalUserId: 'victim',
      platform: 'ios',
      token: 'victim-token',
      environment: 'sandbox'
    });

    await h.post('/swml/park', parkBody({ vars: { userVariables: { subscriber: 'victim' } } }));
    await h.post('/swml/park', parkBody({ vars: { subscriber: 'victim' }, subscriber: 'victim' }));

    assert.deepEqual(
      h.sent.map((push) => push.device.externalUserId),
      ['rn-example', 'rn-example']
    );
  });

  it('takes ?subscriber= on the handler URL, which only the resource owner sets', async () => {
    const h = await harness();
    await h.post('/swml/park?subscriber=rn-example', parkBody());
    assert.deepEqual(h.sent.map((push) => push.device.externalUserId), ['rn-example']);
  });
});

describe('who a bridge is for', () => {
  it('checks the token against who is calling, not a subscriber the caller named', async () => {
    // The device dials `<bridge>?bridgeToken=…`; anything else on that query
    // is the caller's to choose. Naming the token's owner there skipped the
    // check against the real caller.
    const h = await harness();
    const { token } = h.tokens.mint('parked-sid', 'rn-example');
    const swml = await swmlOf(
      await h.post('/swml/bridge', {
        params: {
          vars: { userVariables: { bridgeToken: token, subscriber: 'rn-example' } },
          call: { from: '/private/someone-else' }
        }
      })
    );

    assert.deepEqual(verbs(swml), ['hangup']);
  });
});

describe('a park nobody can answer', () => {
  it('does not answer the caller when the user has no device', async () => {
    // Answering bills the caller's leg and plays a minute of ringing nobody
    // can pick up. Without an answer, the hangup turns the call away.
    const h = await harness({ routes: { '/public/rn-example-park': 'nobody' } });
    const swml = await swmlOf(await h.post('/swml/park', parkBody()));

    assert.deepEqual(swml.sections.main, [{ hangup: { reason: 'busy' } }]);
  });

  it('does not answer when every push failed', async () => {
    const h = await harness({
      routes: { '/public/rn-example-park': 'rn-example' },
      sender: {
        platform: 'ios',
        async send() {
          throw new Error('APNs 403: InvalidProviderToken');
        }
      }
    });
    const swml = await swmlOf(await h.post('/swml/park', parkBody()));

    assert.deepEqual(swml.sections.main, [{ hangup: { reason: 'busy' } }]);
  });

  it('parks without waiting out a push that is taking too long', async () => {
    // The park answers SignalWire's SWML fetch; the caller hears nothing until
    // it does. A stalled provider must not hold that reply.
    const h = await harness({
      routes: { '/public/rn-example-park': 'rn-example' },
      pushWaitMs: 50,
      sender: {
        platform: 'ios',
        send: () => new Promise<void>(() => undefined)
      }
    });

    const started = Date.now();
    const swml = await swmlOf(await h.post('/swml/park', parkBody()));

    assert.ok(Date.now() - started < 1000, 'the park waited on the push');
    // Not known to have failed, so the caller is parked as usual.
    assert.deepEqual(verbs(swml), ['answer', 'play', 'hangup']);
  });
});

describe('POST /swml/bridge/status', () => {
  it('does not end a caller whose token was never redeemed', async () => {
    // The status_url is only handed out by a successful bridge. A callback
    // for an unredeemed token did not come from that connect.
    const h = await harness({ publicUrl: PUBLIC_URL });
    const { token } = h.tokens.mint('parked-sid', 'rn-example');

    await h.post(`/swml/bridge/status?token=${token}`, { params: { connect_state: 'failed' } });
    await settle();

    assert.deepEqual(h.ended, []);
  });

  it('ends the caller once, however many callbacks arrive', async () => {
    const h = await harness({ publicUrl: PUBLIC_URL });
    const { token } = h.tokens.mint('parked-sid', 'rn-example');
    h.tokens.redeem(token, 'rn-example');

    for (const state of ['failed', 'disconnected', 'disconnected']) {
      await h.post(`/swml/bridge/status?token=${token}`, { params: { connect_state: state } });
    }
    await settle();

    assert.deepEqual(h.ended.map((end) => end.callId), ['parked-sid']);
  });

  it('ends the caller when the device hangs up minutes after the park', async () => {
    // Park at T0, answer at T0+10s, a two-minute conversation: the callback
    // arrives at T0+130s, past the 60 s redemption window.
    let now = 0;
    const tokens = new BridgeTokenStore({ now: () => now });
    const h = await harness({ publicUrl: PUBLIC_URL, tokens });
    const { token } = tokens.mint('parked-sid', 'rn-example');
    now = 10_000;
    tokens.redeem(token, 'rn-example');

    now = 130_000;
    await h.post(`/swml/bridge/status?token=${token}`, { params: { connect_state: 'disconnected' } });
    await settle();

    assert.deepEqual(h.ended.map((end) => end.callId), ['parked-sid']);
  });
});

describe('POST /swml/decline', () => {
  it('ends the parked caller when the user declines, instead of a minute of ringback', async () => {
    const h = await harness();
    const { token } = h.tokens.mint('parked-sid', 'rn-example');

    const response = await h.post('/swml/decline', { bridgeToken: token });

    assert.equal(response.status, 204);
    assert.deepEqual(h.ended, [{ callId: 'parked-sid', reason: 'decline' }]);
  });

  it('spends the token, so a declined call cannot then be bridged', async () => {
    const h = await harness();
    const { token } = h.tokens.mint('parked-sid', 'rn-example');
    await h.post('/swml/decline', { bridgeToken: token });

    const swml = await swmlOf(
      await h.post('/swml/bridge', {
        params: { vars: { userVariables: { bridgeToken: token } }, call: { from: '/private/rn-example' } }
      })
    );
    assert.deepEqual(verbs(swml), ['hangup']);
  });

  it('refuses to decline a call another device already answered', async () => {
    const h = await harness();
    const { token } = h.tokens.mint('parked-sid', 'rn-example');
    h.tokens.redeem(token, 'rn-example');

    const response = await h.post('/swml/decline', { bridgeToken: token });

    assert.equal(response.status, 409);
    assert.deepEqual(h.ended, []);
  });

  it('declines once', async () => {
    const h = await harness();
    const { token } = h.tokens.mint('parked-sid', 'rn-example');
    await h.post('/swml/decline', { bridgeToken: token });
    const again = await h.post('/swml/decline', { bridgeToken: token });

    assert.equal(again.status, 409);
    assert.equal(h.ended.length, 1);
  });

  it('answers 404 for a token it never minted', async () => {
    const h = await harness();
    const response = await h.post('/swml/decline', { bridgeToken: 'not-a-token' });
    assert.equal(response.status, 404);
  });

  it('answers 400 without a token', async () => {
    const h = await harness();
    const response = await h.post('/swml/decline', {});
    assert.equal(response.status, 400);
  });

  it('says so when no call ender is configured, and leaves the token redeemable', async () => {
    const h = await harness({ noEnder: true });
    const { token } = h.tokens.mint('parked-sid', 'rn-example');

    const response = await h.post('/swml/decline', { bridgeToken: token });

    assert.equal(response.status, 503);
    assert.ok('callSid' in h.tokens.redeem(token, 'rn-example'));
  });

  it('needs no SignalWire signature: the app calls it, holding the pushed token', async () => {
    const h = await harness({ signingKey: SIGNING_KEY, publicUrl: PUBLIC_URL });
    const { token } = h.tokens.mint('parked-sid', 'rn-example');

    const response = await h.post('/swml/decline', { bridgeToken: token });

    assert.equal(response.status, 204);
  });
});

describe('a park that ends itself', () => {
  /** Parks a call and returns its SWML and the state URL it polls. */
  async function park(h: Harness, callId = 'a-leg-sid'): Promise<{ swml: Swml; stateUrl: string }> {
    const response = await h.signedPost('/swml/park', parkBody({ call: { call_id: callId, to: '/public/rn-example-park', from: '+15551234567' } }));
    const swml = await swmlOf(response);
    const request = swml.sections.main.find((verb) => 'request' in verb)?.request;
    return { swml, stateUrl: String(request?.url ?? '') };
  }

  /** Polls as SignalWire would, with `%{call.call_id}` substituted. */
  async function poll(h: Harness, stateUrl: string, callId = 'a-leg-sid'): Promise<Response> {
    const url = new URL(stateUrl.replace('%{call.call_id}', callId));
    assert.equal(url.origin + url.pathname, `${PUBLIC_URL}/swml/park/state`);
    return fetch(`${h.base}/swml/park/state${url.search}`);
  }

  const signed = {
    signingKey: SIGNING_KEY,
    publicUrl: PUBLIC_URL,
    routes: { '/public/rn-example-park': 'rn-example' }
  };

  it('loops a short ringback and polls, instead of one long play', async () => {
    const h = await harness(signed);
    const { swml, stateUrl } = await park(h);

    assert.deepEqual(verbs(swml), ['answer', 'label', 'play', 'request', 'switch', 'goto', 'hangup']);
    const [, label, play, request, choice, jump, hangup] = swml.sections.main;
    assert.equal(play.play.url, 'ring:6.0:us');
    assert.equal(request.request.method, 'GET');
    assert.equal(request.request.save_variables, true);
    assert.match(stateUrl, /^https:\/\/push\.example\.test\/swml\/park\/state\?call=%\{call\.call_id\}&key=[0-9a-f-]{36}$/);
    assert.deepEqual(choice.switch, { variable: 'vars.request_response.end', case: { yes: [{ hangup: {} }] } });
    // 60 s of 6 s chunks: ten plays, so nine jumps back, then the busy hangup.
    assert.deepEqual(jump.goto, { label: label.label, max: 9 });
    assert.deepEqual(hangup, { hangup: { reason: 'busy' } });
  });

  it('keeps the park key out of the push: only SignalWire gets it', async () => {
    const h = await harness(signed);
    const { stateUrl } = await park(h);
    const key = new URL(stateUrl.replace('%{call.call_id}', 'x')).searchParams.get('key');

    assert.ok(key);
    assert.equal(JSON.stringify(h.sent).includes(key), false);
  });

  it('answers "no" while the caller waits', async () => {
    const h = await harness(signed);
    const { stateUrl } = await park(h);

    const response = await poll(h, stateUrl);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { end: 'no' });
  });

  it('answers "yes" once the user declines, and still tries calling.end', async () => {
    const h = await harness(signed);
    const { stateUrl } = await park(h);
    const token = String(h.sent[0]?.payload.call_id);

    assert.equal((await h.post('/swml/decline', { bridgeToken: token })).status, 204);
    assert.deepEqual(await (await poll(h, stateUrl)).json(), { end: 'yes' });
    assert.deepEqual(h.ended, [{ callId: 'a-leg-sid', reason: 'decline' }]);
  });

  it('declines without a call ender: the park hangs up on its next poll', async () => {
    const h = await harness({ ...signed, noEnder: true });
    const { stateUrl } = await park(h);
    const token = String(h.sent[0]?.payload.call_id);

    assert.equal((await h.post('/swml/decline', { bridgeToken: token })).status, 204);
    assert.deepEqual(await (await poll(h, stateUrl)).json(), { end: 'yes' });
  });

  it('declines when calling.end fails: the poll still ends the caller', async () => {
    const h = await harness({
      ...signed,
      callEnder: { async end() { return { ok: false, error: '500 boom', status: 500 }; } }
    });
    const { stateUrl } = await park(h);
    const token = String(h.sent[0]?.payload.call_id);

    assert.equal((await h.post('/swml/decline', { bridgeToken: token })).status, 204);
    assert.deepEqual(await (await poll(h, stateUrl)).json(), { end: 'yes' });
  });

  it('answers "yes" once a bridged call has ended, and ends the caller', async () => {
    const h = await harness(signed);
    const { stateUrl } = await park(h);
    const token = String(h.sent[0]?.payload.call_id);
    h.tokens.redeem(token, 'rn-example');
    assert.deepEqual(await (await poll(h, stateUrl)).json(), { end: 'no' });

    await h.signedPost(`/swml/bridge/status?token=${token}`, { params: { connect_state: 'disconnected' } });
    await settle();

    assert.deepEqual(await (await poll(h, stateUrl)).json(), { end: 'yes' });
    assert.deepEqual(h.ended.map((end) => end.callId), ['a-leg-sid']);
  });

  it('answers "yes" once the park window is over unanswered', async () => {
    let now = 1_000_000;
    const h = await harness({ ...signed, tokens: new BridgeTokenStore({ now: () => now }) });
    const { stateUrl } = await park(h);

    now += 61_000;
    assert.deepEqual(await (await poll(h, stateUrl)).json(), { end: 'yes' });
  });

  it('answers "yes" for a park it does not know (swept, or the server restarted)', async () => {
    const h = await harness(signed);
    const response = await fetch(`${h.base}/swml/park/state?call=a-leg-sid&key=not-a-key`);
    assert.deepEqual(await response.json(), { end: 'yes' });
  });

  it('refuses a key presented for another call', async () => {
    const h = await harness(signed);
    const { stateUrl } = await park(h);

    assert.equal((await poll(h, stateUrl, 'some-other-call')).status, 403);
  });

  it('answers 400 without the call or the key', async () => {
    const h = await harness(signed);
    assert.equal((await fetch(`${h.base}/swml/park/state?call=a-leg-sid`)).status, 400);
    assert.equal((await fetch(`${h.base}/swml/park/state?key=k`)).status, 400);
  });

  it('keeps one long ringback without PUBLIC_URL, which the poll needs', async () => {
    const h = await harness();
    const swml = await swmlOf(await h.post('/swml/park?subscriber=rn-example', parkBody()));
    assert.deepEqual(verbs(swml), ['answer', 'play', 'hangup']);
  });
});
