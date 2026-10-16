import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import http2 from 'node:http2';
import { duplexPair } from 'node:stream';
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

const sender = (): ApnsVoipSender =>
  new ApnsVoipSender(
    { teamId: 'TEAM', keyId: 'KEY', privateKey: ec.privateKey, bundleId: 'com.example.app' },
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
