import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createApp } from './app.js';
import { InMemoryDeviceStore } from './core/DeviceStore.js';
import { NotificationService } from './core/NotificationService.js';

import type { Server } from 'node:http';
import type { Device, PushPayload, PushSender } from './core/types.js';

const sent: Array<{ device: Device; payload: PushPayload }> = [];

const sender: PushSender = {
  platform: 'ios',
  async send(device, payload) {
    sent.push({ device, payload });
  }
};

const store = new InMemoryDeviceStore();
const app = createApp({
  store,
  service: new NotificationService({ store, senders: [sender], uuid: () => 'fixed' }),
  apiToken: 'secret'
});

let server: Server;
let base: string;

const call = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer secret',
      ...(init.headers ?? {})
    }
  });

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(() => server.close());

describe('health', () => {
  it('is reachable without a token', async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
  });
});

describe('auth', () => {
  it('rejects a request with no token', async () => {
    const response = await fetch(`${base}/devices`);
    assert.equal(response.status, 401);
  });

  it('rejects a wrong token', async () => {
    const response = await fetch(`${base}/devices`, {
      headers: { authorization: 'Bearer nope' }
    });
    assert.equal(response.status, 401);
  });
});

describe('POST /devices', () => {
  it('registers an iOS device', async () => {
    const response = await call('/devices', {
      method: 'POST',
      body: JSON.stringify({
        externalUserId: 'user-1',
        platform: 'ios',
        token: 'ios-token',
        environment: 'sandbox'
      })
    });

    assert.equal(response.status, 201);
    const body = (await response.json()) as { device: Device };
    assert.equal(body.device.token, 'ios-token');
    assert.equal(body.device.environment, 'sandbox');
  });

  it('requires environment for iOS, since sandbox and production differ', async () => {
    const response = await call('/devices', {
      method: 'POST',
      body: JSON.stringify({ externalUserId: 'user-1', platform: 'ios', token: 'x' })
    });
    assert.equal(response.status, 400);
  });

  it('rejects an unknown platform', async () => {
    const response = await call('/devices', {
      method: 'POST',
      body: JSON.stringify({ externalUserId: 'u', platform: 'windows', token: 'x' })
    });
    assert.equal(response.status, 400);
  });

  it('rejects a missing externalUserId', async () => {
    const response = await call('/devices', {
      method: 'POST',
      body: JSON.stringify({ platform: 'android', token: 'x' })
    });
    assert.equal(response.status, 400);
  });
});

describe('POST /notify', () => {
  it('fans out to the user devices', async () => {
    sent.length = 0;
    const response = await call('/notify', {
      method: 'POST',
      body: JSON.stringify({
        externalUserId: 'user-1',
        correlationId: 'call-42',
        from: '+15551234',
        fromName: 'Ada'
      })
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { delivered: number };
    assert.equal(body.delivered, 1);
    assert.equal(sent[0]?.payload.call_id, 'call-42');
    assert.equal(sent[0]?.payload.from_name, 'Ada');
  });

  it('refuses a request with no correlationId', async () => {
    const response = await call('/notify', {
      method: 'POST',
      body: JSON.stringify({ externalUserId: 'user-1' })
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /correlationId/);
  });
});

describe('POST /webhooks/signalwire/inbound', () => {
  it('maps a webhook body and notifies', async () => {
    sent.length = 0;
    const response = await call('/webhooks/signalwire/inbound', {
      method: 'POST',
      body: JSON.stringify({
        call_id: 'call-77',
        to_subscriber_id: 'user-1',
        from: '+15559999',
        from_name: 'Grace'
      })
    });

    assert.equal(response.status, 200);
    assert.equal(sent[0]?.payload.call_id, 'call-77');
    assert.equal(sent[0]?.payload.from_name, 'Grace');
  });

  it('returns 422 and echoes the body when it cannot be mapped', async () => {
    const response = await call('/webhooks/signalwire/inbound', {
      method: 'POST',
      body: JSON.stringify({ something: 'unexpected' })
    });

    assert.equal(response.status, 422);
    const body = (await response.json()) as { received: unknown };
    assert.deepEqual(body.received, { something: 'unexpected' });
  });
});

describe('DELETE /devices/:token', () => {
  it('removes a registered device', async () => {
    const response = await call('/devices/ios-token', { method: 'DELETE' });
    assert.equal(response.status, 204);
    assert.equal((await store.all()).length, 0);
  });

  it('404s for an unknown token', async () => {
    const response = await call('/devices/nope', { method: 'DELETE' });
    assert.equal(response.status, 404);
  });
});
