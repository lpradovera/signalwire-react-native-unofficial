import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { InMemoryDeviceStore } from '../core/DeviceStore.js';
import { NotificationService } from '../core/NotificationService.js';
import { SubscriberTokenMinter } from '../signalwire/subscriberTokens.js';
import { createDevAuthenticateCaller, createTokenRoutes } from './token.js';

import type { Server } from 'node:http';

const NOW_MS = Date.UTC(2026, 9, 16, 12, 0, 0);
const NOW_S = NOW_MS / 1000;

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
  ttlSeconds?: number;
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
            fetchImpl,
            ttlSeconds: options.ttlSeconds,
            now: () => NOW_MS
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
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
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
    assert.deepEqual(await response.json(), {
      token: 'sat-1',
      reference: 'default-ref',
      expires_at: NOW_S + 7200
    });
  });

  it('sends basic auth and the reference to the Fabric endpoint', async () => {
    const built = buildApp({});
    await post(built, { reference: 'sub-42' });

    const [call] = built.calls;
    assert.equal(call?.url, 'https://example.signalwire.com/api/fabric/subscribers/tokens');
    assert.deepEqual(call?.body, { reference: 'sub-42', expire_at: NOW_S + 7200 });
    assert.equal(
      call?.authorization,
      `Basic ${Buffer.from('proj:secret-api-token').toString('base64')}`
    );
  });

  it('mints with the configured lifetime and returns when it ends', async () => {
    const built = buildApp({ ttlSeconds: 120 });
    const response = await post(built, { reference: 'sub-42' });

    assert.equal((built.calls[0]?.body as { expire_at: number }).expire_at, NOW_S + 120);
    assert.equal(((await response.json()) as { expires_at: number }).expires_at, NOW_S + 120);
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

  for (const status of [401, 403, 422]) {
    it(`reports a SignalWire ${status} as a gateway error, not the app's own auth failure (server-18)`, async () => {
      // The server's project credentials (or its reference mapping) were
      // refused, not the app's: a 401 here would send the app to re-login.
      const built = buildApp({ reply: { status, body: { error: 'refused' } } });
      const response = await post(built);

      assert.equal(response.status, 502);
      const { error } = (await response.json()) as { error: string };
      assert.match(error, new RegExp(`refused to mint a token \\(${status}\\)`));
      if (status !== 422) {
        assert.match(error, /SIGNALWIRE_PROJECT_ID/);
      }
    });
  }

  it('fails clearly when the response carries no recognisable token', async () => {
    const built = buildApp({ reply: { status: 200, body: { unexpected: true } } });
    const response = await post(built);

    assert.equal(response.status, 502);
    assert.match(((await response.json()) as { error: string }).error, /no recognisable token/i);
  });

  it('explains the missing configuration rather than 404ing', async () => {
    const built = buildApp({ configured: false });
    const response = await post(built);

    assert.equal(response.status, 503);
    assert.match(((await response.json()) as { error: string }).error, /SIGNALWIRE_SPACE/);
  });
});
