import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { BridgeTokenStore } from '../core/BridgeTokenStore.js';
import { InMemoryDeviceStore } from '../core/DeviceStore.js';
import { NotificationService } from '../core/NotificationService.js';
import { createSwmlRoutes } from './swml.js';

import type { Server } from 'node:http';
import type { SwmlRouteOptions } from './swml.js';

/**
 * How long the park holds the caller. SWML `play` has no loop, so the park
 * repeats the ringback URL; the number of repeats must come from the
 * recording's real length, or the caller is hung up early (a short file) or
 * held past the window (a long one).
 */

const servers: Server[] = [];
after(() => servers.forEach((server) => server.close()));

async function park(options: Partial<SwmlRouteOptions>): Promise<string[]> {
  const store = new InMemoryDeviceStore();
  await store.register({ externalUserId: 'rn-example', platform: 'ios', token: 't', environment: 'sandbox' });
  const service = new NotificationService({
    store,
    senders: [{ platform: 'ios', async send() {} }]
  });
  const app = createApp({
    store,
    service,
    swmlRoutes: createSwmlRoutes({ tokens: new BridgeTokenStore(), service, ...options })
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const response = await fetch(`http://127.0.0.1:${port}/swml/park?subscriber=rn-example`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ params: { call: { call_id: 'a-leg', from: '+15550001' } } })
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const swml = (await response.json()) as { sections: { main: any[] } };
  const play = swml.sections.main.find((verb) => 'play' in verb);
  return play.play.urls as string[];
}

describe('park ringback length', () => {
  it('repeats the generated 15 s tone to fill the 60 s window', async () => {
    assert.deepEqual(await park({}), Array(4).fill('ring:15.0:us'));
  });

  it('repeats a recording by its stated length', async () => {
    // This server's own /swml/ringback is a 6 s cycle.
    const url = 'https://push.example.test/swml/ringback';
    assert.deepEqual(await park({ ringback: url, ringbackSeconds: 6 }), Array(10).fill(url));
  });

  it('refuses a recording whose length it is not told', () => {
    assert.throws(
      () =>
        createSwmlRoutes({
          tokens: new BridgeTokenStore(),
          service: new NotificationService({ store: new InMemoryDeviceStore(), senders: [] }),
          ringback: 'https://push.example.test/swml/ringback'
        }),
      /PARK_RINGBACK_SECONDS/
    );
  });
});
