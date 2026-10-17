import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { createApp } from './app.js';
import { InMemoryDeviceStore } from './core/DeviceStore.js';
import { NotificationService } from './core/NotificationService.js';

import type { Server } from 'node:http';
import type { DeviceRegistration } from './core/types.js';

/**
 * What a malformed or unexpected request gets back: the status the problem
 * calls for, never a 500 for the client's own mistake, and never an internal
 * error message.
 */

class FailingStore extends InMemoryDeviceStore {
  override async register(_registration: DeviceRegistration): Promise<never> {
    throw new Error("EACCES: permission denied, open '/srv/secret/devices.json'");
  }
}

const servers: Server[] = [];
after(() => servers.forEach((server) => server.close()));

async function start(store = new InMemoryDeviceStore()) {
  const lines: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const app = createApp({
    store,
    service: new NotificationService({ store, senders: [] }),
    log: (message, meta) => lines.push({ message, meta })
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return { base, lines };
}

const json = async (response: Response) => (await response.json()) as { error: string };

describe('error responses', () => {
  it('answers malformed JSON with 400, not 500 (server-17)', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"externalUserId": '
    });
    assert.equal(response.status, 400);
    assert.match((await json(response)).error, /JSON/i);
  });

  it('answers an oversized body with 413 (server-17)', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(70 * 1024) })
    });
    assert.equal(response.status, 413);
  });

  it('hides an internal error message behind a generic 500, and logs it (server-17)', async () => {
    const { base, lines } = await start(new FailingStore());
    const response = await fetch(`${base}/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ externalUserId: 'u', platform: 'android', token: 't' })
    });
    assert.equal(response.status, 500);
    const { error } = await json(response);
    assert.doesNotMatch(error, /secret|EACCES/);
    assert.ok(lines.some((line) => String(line.meta?.error).includes('EACCES')));
  });
});

describe('requests without a JSON body (sweep-ops-2)', () => {
  // Express 5 leaves req.body undefined unless the request is
  // application/json; the routes read fields off it unguarded.
  const form = { 'content-type': 'application/x-www-form-urlencoded' };

  it('POST /devices with a form body is a 400 naming the field', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/devices`, { method: 'POST', headers: form, body: 'token=t' });
    assert.equal(response.status, 400);
    assert.match((await json(response)).error, /externalUserId/);
  });

  it('POST /notify with no body is a 400 naming the field', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/notify`, { method: 'POST' });
    assert.equal(response.status, 400);
    assert.match((await json(response)).error, /externalUserId/);
  });

  it('the SignalWire webhook with a form body is its diagnostic 422', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/webhooks/signalwire/inbound`, {
      method: 'POST',
      headers: form,
      body: 'CallSid=CA1'
    });
    assert.equal(response.status, 422);
  });
});
