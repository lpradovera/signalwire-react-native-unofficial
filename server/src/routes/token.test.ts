import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { InMemoryDeviceStore } from '../core/DeviceStore.js';
import { NotificationService } from '../core/NotificationService.js';
import { SubscriberTokenMinter } from '../signalwire/subscriberTokens.js';
import { createDevAuthenticateCaller, createTokenRoutes } from './token.js';

import type { Server } from 'node:http';

/** Records what the minter sent upstream, and replies with `reply`. */
function stubFetch(reply: { status: number; body: unknown }): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; authorization: string; body: unknown }>;
} {
  const calls: Array<{ url: string; authorization: string; body: unknown }> = [];

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      authorization: headers.get('authorization') ?? '',
      body: JSON.parse(String(init?.body ?? '{}'))
    });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' }
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function buildApp(options: {
  reply?: { status: number; body: unknown };
  authenticateCaller?: Parameters<typeof createTokenRoutes>[0]['authenticateCaller'];
  configured?: boolean;
}) {
  const { fetchImpl, calls } = stubFetch(options.reply ?? { status: 200, body: { token: 'sat-1' } });

  const store = new InMemoryDeviceStore();
  const service = new NotificationService({ store, senders: [] });

  const tokenRoutes =
    options.configured === false
      ? undefined
      : createTokenRoutes({
          minter: new SubscriberTokenMinter({
            space: 'example.signalwire.com',
            projectId: 'proj',
            apiToken: 'secret-api-token',
            fetchImpl
          }),
          authenticateCaller: options.authenticateCaller ?? createDevAuthenticateCaller('default-ref')
        });

  return { app: createApp({ store, service, apiToken: 'shared', tokenRoutes }), calls };
}

async function listen(app: ReturnType<typeof buildApp>['app']): Promise<{
  server: Server;
  base: string;
}> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  return {
    server,
    base: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  };
}

describe('POST /token', () => {
  let servers: Server[] = [];

  const post = async (
    built: ReturnType<typeof buildApp>,
    body: unknown = {},
    headers: Record<string, string> = {}
  ) => {
    const { server, base } = await listen(built.app);
    servers.push(server);
    return fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
  };

  before(() => {
    servers = [];
  });
  after(() => servers.forEach((s) => s.close()));

  it('mints a token without the shared API_TOKEN', async () => {
    // The app cannot hold API_TOKEN, so /token must sit outside that guard.
    const built = buildApp({});
    const response = await post(built);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { token: 'sat-1', reference: 'default-ref' });
  });

  it('sends basic auth and the reference to the Fabric endpoint', async () => {
    const built = buildApp({});
    await post(built, { reference: 'sub-42' });

    const [call] = built.calls;
    assert.equal(call?.url, 'https://example.signalwire.com/api/fabric/subscribers/tokens');
    assert.deepEqual(call?.body, { reference: 'sub-42' });
    assert.equal(
      call?.authorization,
      `Basic ${Buffer.from('proj:secret-api-token').toString('base64')}`
    );
  });

  it('rejects when the caller cannot be authenticated', async () => {
    const built = buildApp({ authenticateCaller: () => null });
    const response = await post(built);

    assert.equal(response.status, 401);
    assert.equal(built.calls.length, 0, 'must not reach SignalWire for an unauthenticated caller');
  });

  it('does not let the caller pick the reference when auth supplies one', async () => {
    // Whoever chooses the reference chooses whose calls they receive.
    const built = buildApp({ authenticateCaller: () => 'from-session' });
    await post(built, { reference: 'attacker-choice' });

    assert.equal(built.calls[0]?.body && (built.calls[0].body as { reference: string }).reference, 'from-session');
  });

  it('reports a SignalWire 5xx as a gateway error, not a client error', async () => {
    const built = buildApp({ reply: { status: 500, body: { error: 'boom' } } });
    const response = await post(built);

    assert.equal(response.status, 502);
  });

  it('passes a SignalWire 401 through as-is', async () => {
    const built = buildApp({ reply: { status: 401, body: { error: 'bad creds' } } });
    const response = await post(built);

    assert.equal(response.status, 401);
  });

  it('fails clearly when the response carries no recognisable token', async () => {
    const built = buildApp({ reply: { status: 200, body: { unexpected: true } } });
    const response = await post(built);

    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /no recognisable token/i);
  });

  it('explains the missing configuration rather than 404ing', async () => {
    const built = buildApp({ configured: false });
    const response = await post(built);

    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /SIGNALWIRE_SPACE/);
  });
});
