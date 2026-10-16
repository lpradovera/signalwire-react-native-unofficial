import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, describe, it } from 'node:test';

import { createApp } from './app.js';
import { InMemoryDeviceStore } from './core/DeviceStore.js';
import { NotificationService } from './core/NotificationService.js';
import { createDevAuthenticateCaller } from './routes/token.js';
import { requireSignalWireSignature } from './signalwire/signature.js';

import type { Server } from 'node:http';
import type { AppOptions } from './app.js';
import type { Device, PushPayload, PushSender } from './core/types.js';
import type { Request } from 'express';

/**
 * Who may use /devices and the SignalWire webhook.
 *
 * - `deviceAuth` (DEVICE_AUTH=caller): each request to /devices is
 *   authenticated as one user, by the same seam /token uses. That user is the
 *   only one it can register for, list, or delete.
 * - `signalWireSignature` (SIGNALWIRE_SIGNING_KEY): the webhook is
 *   authenticated by SignalWire's request signature instead of API_TOKEN,
 *   which SignalWire cannot send.
 */

const PUBLIC_URL = 'https://push.example.test';
const SIGNING_KEY = 'PSKtest-signing-key';

const sign = (path: string, body: string): string =>
  createHmac('sha256', SIGNING_KEY).update(`${PUBLIC_URL}${path}${body}`).digest('hex');

/** Test identity: `Authorization: User <id>`. Stands in for the app's own session check. */
const authenticateCaller = (req: Request): string | null => {
  const header = req.header('authorization') ?? '';
  return header.startsWith('User ') ? header.slice(5) : null;
};

const servers: Server[] = [];
after(() => servers.forEach((server) => server.close()));

async function start(options: Partial<AppOptions> = {}) {
  const sent: Array<{ device: Device; payload: PushPayload }> = [];
  const sender: PushSender = {
    platform: 'android',
    async send(device, payload) {
      sent.push({ device, payload });
    }
  };
  const store = new InMemoryDeviceStore();
  const app = createApp({
    store,
    service: new NotificationService({ store, senders: [sender] }),
    apiToken: 'shared-secret',
    ...options
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const request = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }
    });
  return { store, sent, request };
}

const android = (token: string, externalUserId?: string) =>
  JSON.stringify({ platform: 'android', token, ...(externalUserId ? { externalUserId } : {}) });

describe('/devices with per-user auth (deviceAuth)', () => {
  it('refuses a request that is not authenticated as a user, even with API_TOKEN', async () => {
    const { request, store } = await start({ deviceAuth: authenticateCaller });
    const response = await request('/devices', {
      method: 'POST',
      headers: { authorization: 'Bearer shared-secret' },
      body: android('t1', 'alice')
    });
    assert.equal(response.status, 401);
    assert.equal((await store.all()).length, 0);
  });

  it('registers under the authenticated user, not one the body names', async () => {
    const { request, store } = await start({ deviceAuth: authenticateCaller });

    const own = await request('/devices', {
      method: 'POST',
      headers: { authorization: 'User alice' },
      body: android('t1')
    });
    assert.equal(own.status, 201);
    assert.equal((await store.findByUser('alice')).length, 1);

    const forged = await request('/devices', {
      method: 'POST',
      headers: { authorization: 'User mallory' },
      body: android('t2', 'alice')
    });
    assert.equal(forged.status, 403);
    assert.deepEqual(
      (await store.findByUser('alice')).map((d) => d.token),
      ['t1']
    );
  });

  it('lists only the caller’s own devices, whatever the query asks for', async () => {
    const { request, store } = await start({ deviceAuth: authenticateCaller });
    await store.register({ externalUserId: 'alice', platform: 'android', token: 'a1', environment: 'production' });
    await store.register({ externalUserId: 'bob', platform: 'android', token: 'b1', environment: 'production' });

    const response = await request('/devices?externalUserId=alice', {
      headers: { authorization: 'User bob' }
    });
    assert.equal(response.status, 200);
    const { devices } = (await response.json()) as { devices: Device[] };
    assert.deepEqual(
      devices.map((d) => d.token),
      ['b1']
    );
  });

  it('deletes only the caller’s own device', async () => {
    const { request, store } = await start({ deviceAuth: authenticateCaller });
    await store.register({ externalUserId: 'alice', platform: 'android', token: 'a1', environment: 'production' });

    const other = await request('/devices/a1', { method: 'DELETE', headers: { authorization: 'User bob' } });
    assert.equal(other.status, 404);
    assert.equal((await store.all()).length, 1);

    const own = await request('/devices/a1', { method: 'DELETE', headers: { authorization: 'User alice' } });
    assert.equal(own.status, 204);
    assert.equal((await store.all()).length, 0);
  });

  it('leaves /notify behind API_TOKEN', async () => {
    const { request } = await start({ deviceAuth: authenticateCaller });
    const response = await request('/notify', {
      method: 'POST',
      headers: { authorization: 'User alice' },
      body: JSON.stringify({ externalUserId: 'alice', correlationId: 'c1' })
    });
    assert.equal(response.status, 401);
  });
});

describe('/devices without deviceAuth (the default)', () => {
  it('stays behind the shared API_TOKEN', async () => {
    const { request } = await start();
    assert.equal((await request('/devices')).status, 401);
    const ok = await request('/devices', { headers: { authorization: 'Bearer shared-secret' } });
    assert.equal(ok.status, 200);
  });
});

describe('SignalWire webhook with a signing key (signalWireSignature)', () => {
  const PATH = '/webhooks/signalwire/inbound';
  const body = JSON.stringify({ call_id: 'call-1', to_subscriber_id: 'alice', from: '+15550001' });
  const verifier = () => requireSignalWireSignature({ signingKey: SIGNING_KEY, publicUrl: PUBLIC_URL });

  async function withDevice(options: Partial<AppOptions>) {
    const started = await start(options);
    await started.store.register({
      externalUserId: 'alice',
      platform: 'android',
      token: 'a1',
      environment: 'production'
    });
    return started;
  }

  it('accepts a request SignalWire signed, without API_TOKEN', async () => {
    const { request, sent } = await withDevice({ signalWireSignature: verifier() });
    const response = await request(PATH, {
      method: 'POST',
      headers: { 'x-signalwire-sha256-signature': sign(PATH, body) },
      body
    });
    assert.equal(response.status, 200);
    assert.equal(sent.length, 1);
  });

  it('refuses an unsigned request, and pushes nothing', async () => {
    const { request, sent } = await withDevice({ signalWireSignature: verifier() });
    const response = await request(PATH, { method: 'POST', body });
    assert.equal(response.status, 403);
    assert.equal(sent.length, 0);
  });

  it('refuses a forged signature, even with API_TOKEN', async () => {
    const { request, sent } = await withDevice({ signalWireSignature: verifier() });
    const response = await request(PATH, {
      method: 'POST',
      headers: {
        authorization: 'Bearer shared-secret',
        'x-signalwire-sha256-signature': sign(PATH, body.replace('alice', 'bob'))
      },
      body
    });
    assert.equal(response.status, 403);
    assert.equal(sent.length, 0);
  });

  it('without a signing key, stays behind API_TOKEN', async () => {
    const { request, sent } = await withDevice({});
    assert.equal((await request(PATH, { method: 'POST', body })).status, 401);
    const ok = await request(PATH, {
      method: 'POST',
      headers: { authorization: 'Bearer shared-secret' },
      body
    });
    assert.equal(ok.status, 200);
    assert.equal(sent.length, 1);
  });
});

describe('API_TOKEN check', () => {
  it('rejects a token of the wrong length and a same-length wrong token', async () => {
    const { request } = await start();
    for (const token of ['short', 'shared-secreT', 'shared-secret-longer']) {
      const response = await request('/devices', { headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.status, 401, token);
    }
  });
});

describe('development caller stub with DEVICE_AUTH=caller', () => {
  it('takes the user a registration names, so the example can register as itself', async () => {
    const { request, store } = await start({ deviceAuth: createDevAuthenticateCaller('rn-example') });
    const response = await request('/devices', { method: 'POST', body: android('t1', 'rn-android') });
    assert.equal(response.status, 201);
    assert.equal((await store.findByUser('rn-android')).length, 1);
  });
});
