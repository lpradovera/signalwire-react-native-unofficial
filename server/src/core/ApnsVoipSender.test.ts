import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import http2 from 'node:http2';
import { duplexPair } from 'node:stream';
import type { Duplex } from 'node:stream';
import { beforeEach, describe, it } from 'node:test';

import { ApnsVoipSender } from './ApnsVoipSender.js';
import { TokenExpiredError } from './types.js';

import type { Device } from './types.js';

/**
 * A real node:http2 server standing in for APNs, reached through an in-memory
 * duplex pair: the sender's own HTTP/2 client code runs unchanged, with no
 * port and no network.
 */
type Behaviour = (
  stream: http2.ServerHttp2Stream,
  headers: http2.IncomingHttpHeaders,
  attempt: number
) => void;

const fakeApns = http2.createServer();
const seen: Array<{ authority: string; headers: http2.IncomingHttpHeaders; body: string }> = [];
const connects: string[] = [];
/** The client end of each connection, to break it the way a dead NAT mapping does. */
const clientSockets: Duplex[] = [];
const serverSessions: http2.ServerHttp2Session[] = [];
let behaviour: Behaviour;

fakeApns.on('session', (session) => serverSessions.push(session));
fakeApns.on('sessionError', () => undefined);
fakeApns.on('stream', (stream, headers) => {
  stream.on('error', () => undefined);
  let body = '';
  stream.on('data', (chunk: Buffer) => (body += chunk.toString()));
  stream.on('end', () => {
    seen.push({ authority: String(headers[':authority']), headers, body });
    behaviour(stream, headers, seen.length);
  });
});

const connect = (authority: string): http2.ClientHttp2Session => {
  connects.push(authority);
  const [client, server] = duplexPair();
  clientSockets.push(client);
  fakeApns.emit('connection', server);
  return http2.connect(authority, { createConnection: () => client as never });
};

const reply = (status: number, reason?: string): Behaviour => (stream) => {
  stream.respond({ ':status': status, 'content-type': 'application/json' });
  stream.end(reason ? JSON.stringify({ reason }) : undefined);
};

const ec = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
});

const sender = (options: { keepaliveMs?: number; pingTimeoutMs?: number } = {}): ApnsVoipSender =>
  new ApnsVoipSender(
    {
      teamId: 'TEAM',
      keyId: 'KEY',
      privateKey: ec.privateKey,
      bundleId: 'com.example.app',
      ...options
    },
    connect
  );

const device = (token = 'abc123', environment: 'sandbox' | 'production' = 'sandbox'): Device => ({
  externalUserId: 'u',
  platform: 'ios',
  token,
  environment,
  updatedAt: 0
});

const payload = { call_id: 'c', from: 'f', from_name: 'n' };

const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => assert.fail('expected the send to reject'),
    (error: unknown) => error
  );

beforeEach(() => {
  seen.length = 0;
  connects.length = 0;
  clientSockets.length = 0;
  behaviour = reply(200);
});

describe('ApnsVoipSender: request', () => {
  it('sends a VoIP push that is delivered now or discarded', async () => {
    await sender().send(device(), payload);

    const headers = seen[0]?.headers ?? {};
    assert.equal(headers[':path'], '/3/device/abc123');
    assert.equal(headers['apns-push-type'], 'voip');
    assert.equal(headers['apns-topic'], 'com.example.app.voip');
    assert.equal(headers['apns-priority'], '10');
    assert.equal(headers['apns-expiration'], '0');
    assert.match(String(headers.authorization), /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    assert.deepEqual(JSON.parse(seen[0]?.body ?? '{}'), payload);
  });

  it('picks the host from the device environment', async () => {
    const apns = sender();
    await apns.send(device('s', 'sandbox'), payload);
    await apns.send(device('p', 'production'), payload);
    assert.deepEqual(connects, ['https://api.sandbox.push.apple.com', 'https://api.push.apple.com']);
  });
});

describe('ApnsVoipSender: connection', () => {
  it('reuses one connection per environment across calls and devices', async () => {
    // Apple: reuse a connection for hours to days. A new TLS + HTTP/2 setup
    // per push sat on every incoming call's critical path.
    const apns = sender();
    await Promise.all(['a', 'b', 'c'].map((token) => apns.send(device(token), payload)));
    await Promise.all(['a', 'b', 'c'].map((token) => apns.send(device(token), payload)));

    assert.equal(seen.length, 6);
    assert.equal(connects.length, 1);
  });

  it('carries many concurrent pushes on one connection without leaking listeners', async () => {
    const warnings: string[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning.name);
    };
    process.on('warning', onWarning);
    try {
      const apns = sender();
      const tokens = Array.from({ length: 25 }, (_, index) => `t${index}`);
      await Promise.all(tokens.map((token) => apns.send(device(token), payload)));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', onWarning);
    }
    assert.equal(connects.length, 1);
    assert.deepEqual(warnings, []);
  });

  it('reconnects once APNs closes the connection', async () => {
    const apns = sender();
    await apns.send(device(), payload);
    assert.equal(connects.length, 1);

    // APNs closes idle connections and sends GOAWAY on maintenance.
    const closed = new Promise<void>((resolve) => serverSessions.at(-1)?.close(resolve));
    await closed;
    await new Promise((resolve) => setImmediate(resolve));

    await apns.send(device(), payload);
    assert.equal(connects.length, 2);
  });

  it('turns a connection that fails into a rejected send, not a crash', async () => {
    const failing = new ApnsVoipSender(
      { teamId: 'TEAM', keyId: 'KEY', privateKey: ec.privateKey, bundleId: 'com.example.app' },
      (authority) => {
        const [client] = duplexPair();
        const session = http2.connect(authority, { createConnection: () => client as never });
        setImmediate(() => client.destroy(new Error('connect ECONNREFUSED')));
        return session;
      }
    );
    await assert.rejects(failing.send(device(), payload));
  });
});

describe('ApnsVoipSender: errors', () => {
  it('prunes 410 Unregistered', async () => {
    behaviour = reply(410, 'Unregistered');
    const error = await rejection(sender().send(device(), payload));
    assert.ok(error instanceof TokenExpiredError);
    assert.match(error.reason ?? '', /Unregistered/);
  });

  it('prunes 400 BadDeviceToken but says it may be the wrong environment', async () => {
    // Apple returns BadDeviceToken for a valid token sent to the wrong
    // environment — a release build registered as "sandbox" — which is the
    // most common push failure there is. Reporting it as merely "expired"
    // hides the actual fix.
    behaviour = reply(400, 'BadDeviceToken');
    const error = await rejection(sender().send(device('t', 'sandbox'), payload));
    assert.ok(error instanceof TokenExpiredError);
    assert.match(error.reason ?? '', /BadDeviceToken/);
    assert.match(error.reason ?? '', /sandbox/);
    assert.match(error.reason ?? '', /environment/);
  });

  it('keeps the token on other 400s', async () => {
    behaviour = reply(400, 'BadTopic');
    const error = await rejection(sender().send(device(), payload));
    assert.ok(error instanceof Error);
    assert.equal(error instanceof TokenExpiredError, false);
    assert.match(error.message, /APNs 400: .*BadTopic/);
  });

  it('re-mints a provider token APNs calls expired, and retries the push once', async () => {
    behaviour = (stream, _headers, attempt) =>
      attempt === 1 ? reply(403, 'ExpiredProviderToken')(stream, _headers, attempt) : reply(200)(stream, _headers, attempt);
    const apns = sender();
    await apns.send(device(), payload);

    assert.equal(seen.length, 2);
    assert.notEqual(seen[0]?.headers.authorization, seen[1]?.headers.authorization);

    // The fresh token is the cached one from then on.
    await apns.send(device(), payload);
    assert.equal(seen[2]?.headers.authorization, seen[1]?.headers.authorization);
  });

  it('reports ExpiredProviderToken that a fresh token does not cure, without looping', async () => {
    behaviour = reply(403, 'ExpiredProviderToken');
    await assert.rejects(sender().send(device(), payload), /APNs 403: .*ExpiredProviderToken/);
    assert.equal(seen.length, 2);
  });
});

describe('ApnsVoipSender: a stream that ends without a response (server-36)', () => {
  it('says the stream was closed, with its code, instead of "APNs 0: (no body)"', async () => {
    behaviour = (stream) => stream.close(http2.constants.NGHTTP2_NO_ERROR);
    const error = (await rejection(sender().send(device(), payload))) as Error;
    assert.doesNotMatch(error.message, /APNs 0/);
    assert.match(error.message, /no response/i);
    assert.match(error.message, /NO_ERROR|code 0/);
  });

  it('carries the reason Apple puts in a GOAWAY frame', async () => {
    behaviour = (stream) => {
      stream.session?.goaway(
        http2.constants.NGHTTP2_NO_ERROR,
        0,
        Buffer.from(JSON.stringify({ reason: 'Shutdown' }))
      );
    };
    const error = (await rejection(sender().send(device(), payload))) as Error;
    assert.match(error.message, /GOAWAY/);
    assert.match(error.message, /Shutdown/);
  });
});

/** The socket error a connection the network dropped while idle gives on its next write. */
const connectionReset = (): Error =>
  Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read', errno: -54 });

/** Resets the connection under the given attempts, as a stale one does; answers 200 otherwise. */
const resetOn = (...attempts: number[]): Behaviour => (stream, headers, attempt) => {
  if (attempts.includes(attempt)) {
    clientSockets.at(-1)?.destroy(connectionReset());
    return;
  }
  reply(200)(stream, headers, attempt);
};

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('ApnsVoipSender: a stale reused connection (BUG-P1)', () => {
  it('retries once on a new connection when a reused one turns out to be reset', async () => {
    // Device test, 2026-10-17: the first push after ten idle minutes failed
    // with "read ECONNRESET" and the caller was turned away; the next push,
    // on a new connection, rang.
    const apns = sender();
    await apns.send(device(), payload);
    behaviour = resetOn(2);

    await apns.send(device(), payload);

    assert.equal(connects.length, 2);
    assert.equal(seen.length, 3);
  });

  it('retries once when APNs resets the stream on a reused connection', async () => {
    const apns = sender();
    await apns.send(device(), payload);
    behaviour = (stream, headers, attempt) =>
      attempt === 2
        ? stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR)
        : reply(200)(stream, headers, attempt);

    await apns.send(device(), payload);

    assert.equal(seen.length, 3);
    // The suspect connection is replaced, not reused for the retry.
    assert.equal(connects.length, 2);
  });

  it('does not retry on a connection it has just opened', async () => {
    behaviour = resetOn(1);
    await assert.rejects(sender().send(device(), payload), /ECONNRESET/);
    assert.equal(connects.length, 1);
    assert.equal(seen.length, 1);
  });

  it('retries only once, and says so', async () => {
    const apns = sender();
    await apns.send(device(), payload);
    behaviour = resetOn(2, 3);

    const error = (await rejection(apns.send(device(), payload))) as Error;
    assert.match(error.message, /ECONNRESET/);
    assert.match(error.message, /new connection/);
    assert.equal(connects.length, 2);
    assert.equal(seen.length, 3);
  });

  it('does not retry a push APNs answered', async () => {
    const apns = sender();
    await apns.send(device(), payload);
    behaviour = reply(500, 'InternalServerError');

    await assert.rejects(apns.send(device(), payload), /APNs 500/);
    assert.equal(seen.length, 2);
    assert.equal(connects.length, 1);
  });

  it('retries every push that was waiting on the reset connection', async () => {
    const apns = sender();
    await apns.send(device(), payload);
    let reset = false;
    behaviour = (stream, headers, attempt) => {
      if (!reset && attempt > 1) {
        reset = true;
        clientSockets.at(-1)?.destroy(connectionReset());
        return;
      }
      reply(200)(stream, headers, attempt);
    };

    await Promise.all(['a', 'b', 'c'].map((token) => apns.send(device(token), payload)));
    assert.equal(connects.length, 2);
  });
});

describe('ApnsVoipSender: keepalive (BUG-P1)', () => {
  it('pings an idle connection, so the network does not drop it', async () => {
    const apns = sender({ keepaliveMs: 20 });
    await apns.send(device(), payload);
    let pings = 0;
    serverSessions.at(-1)?.on('ping', () => (pings += 1));

    await settle(110);

    assert.ok(pings >= 2, `expected at least 2 pings, saw ${pings}`);
    // Still the one connection: answered pings keep it.
    await apns.send(device(), payload);
    assert.equal(connects.length, 1);
  });

  it('drops a connection whose ping goes unanswered; the next push opens a new one', async () => {
    // A path that silently stops carrying packets: no RST, no FIN. Bytes are
    // relayed between the two ends until `blackholed` is set.
    let blackholed = false;
    const relayed = (authority: string): http2.ClientHttp2Session => {
      connects.push(authority);
      const [client, near] = duplexPair();
      const [far, server] = duplexPair();
      near.on('data', (chunk: Buffer) => blackholed || far.write(chunk));
      far.on('data', (chunk: Buffer) => blackholed || near.write(chunk));
      fakeApns.emit('connection', server);
      return http2.connect(authority, { createConnection: () => client as never });
    };
    const apns = new ApnsVoipSender(
      {
        teamId: 'TEAM',
        keyId: 'KEY',
        privateKey: ec.privateKey,
        bundleId: 'com.example.app',
        keepaliveMs: 20,
        pingTimeoutMs: 30
      },
      relayed
    );
    await apns.send(device(), payload);

    blackholed = true;
    await settle(120);
    blackholed = false;

    await apns.send(device(), payload);
    assert.equal(connects.length, 2);
  });

  it('can be turned off', async () => {
    const apns = sender({ keepaliveMs: 0 });
    await apns.send(device(), payload);
    let pings = 0;
    serverSessions.at(-1)?.on('ping', () => (pings += 1));
    await settle(60);
    assert.equal(pings, 0);
  });
});
