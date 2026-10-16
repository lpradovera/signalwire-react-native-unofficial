import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { CALL_PUSH_TTL_SECONDS, FcmSender, dataPayload } from './FcmSender.js';
import { TokenExpiredError } from './types.js';

import type { Device } from './types.js';

describe('dataPayload', () => {
  it('renames keys FCM reserves, which would fail the whole message', () => {
    // `from` is the natural name for a caller and APNs accepts it happily, so
    // this presents as "Android push is broken" while iOS works — same call,
    // same payload. FCM rejects the entire message with
    // `400 Invalid data payload key: from`.
    const data = dataPayload({ call_id: 'c1', from: '+15551234567', from_name: 'Ada' });

    assert.equal(data.from, undefined);
    assert.equal(data.sw_from, '+15551234567');
    assert.equal(data.call_id, 'c1');
    assert.equal(data.from_name, 'Ada');
  });

  it('stringifies values, because FCM rejects non-strings', () => {
    const data = dataPayload({ count: 3, flag: true });
    assert.equal(data.count, '3');
    assert.equal(data.flag, 'true');
  });

  it('drops null and undefined rather than sending the string "null"', () => {
    const data = dataPayload({ a: null, b: undefined, c: 'keep' });
    assert.deepEqual(Object.keys(data), ['c']);
  });
});

const rsa = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
});

const OAUTH_URL = 'https://oauth2.googleapis.com/token';

interface Seen {
  url: string;
  init: RequestInit;
}

/**
 * A fetch that plays Google: the OAuth endpoint mints `ya29.<n>` tokens, and
 * the FCM endpoint answers with whatever `fcm` returns for that request.
 */
function fakeGoogle(fcm: (init: RequestInit, attempt: number) => Response | Promise<Response>) {
  const calls: Seen[] = [];
  let minted = 0;
  let sends = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (String(url) === OAUTH_URL) {
      // A real exchange takes a round trip; concurrent callers overlap here.
      await new Promise((resolve) => setTimeout(resolve, 5));
      minted += 1;
      return Response.json({ access_token: `ya29.${minted}`, expires_in: 3599 });
    }
    sends += 1;
    return fcm(init ?? {}, sends);
  }) as typeof fetch;
  return {
    fetchImpl,
    calls,
    oauthCalls: () => calls.filter((call) => call.url === OAUTH_URL),
    fcmCalls: () => calls.filter((call) => call.url.includes('fcm.googleapis.com'))
  };
}

const config = {
  projectId: 'proj',
  clientEmail: 'svc@proj.iam.gserviceaccount.com',
  privateKey: rsa.privateKey
};

const device = (token = 'fcm-token'): Device => ({
  externalUserId: 'u',
  platform: 'android',
  token,
  environment: 'production',
  updatedAt: 0
});

const payload = { call_id: 'c1', from: '+15551234567', from_name: 'Ada' };
const ok = (): Response => Response.json({ name: 'projects/proj/messages/1' });

/** An FCM v1 error body, in the shape the API documents. */
const fcmError = (
  status: number,
  rpcStatus: string,
  message: string,
  errorCode: string,
  extraDetails: unknown[] = []
): Response =>
  Response.json(
    {
      error: {
        code: status,
        message,
        status: rpcStatus,
        details: [
          { '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode },
          ...extraDetails
        ]
      }
    },
    { status }
  );

describe('FcmSender.send: message', () => {
  it('sends a data-only, high-priority message with a short TTL', async () => {
    const google = fakeGoogle(ok);
    await new FcmSender(config, google.fetchImpl).send(device(), payload);

    const body = JSON.parse(String(google.fcmCalls()[0]?.init.body)) as {
      message: { token: string; data: Record<string, string>; android: Record<string, unknown> };
    };
    assert.equal(body.message.token, 'fcm-token');
    assert.equal('notification' in body.message, false);
    assert.equal(body.message.android.priority, 'high');
    // Without a TTL, FCM stores a message for an offline device for four weeks
    // and delivers it on reconnect: the phone rings for a call that ended
    // hours ago. A call push is worthless after the bridge token expires.
    assert.equal(body.message.android.ttl, `${CALL_PUSH_TTL_SECONDS}s`);
    assert.equal(CALL_PUSH_TTL_SECONDS, 60);
  });

  it('bounds both requests with a timeout', async () => {
    const google = fakeGoogle(ok);
    await new FcmSender(config, google.fetchImpl).send(device(), payload);
    assert.equal(google.calls.length, 2);
    for (const call of google.calls) {
      assert.ok(call.init.signal instanceof AbortSignal, `${call.url} carries no AbortSignal`);
    }
  });

  it('gives up on a stalled request instead of waiting for the platform default', async () => {
    // Never answers, but honours abort the way fetch does.
    const stalled = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const sender = new FcmSender({ ...config, timeoutMs: 50 }, stalled);

    const started = Date.now();
    await assert.rejects(sender.send(device(), payload));
    assert.ok(Date.now() - started < 1000, 'the stalled request was not abandoned');
  });
});

describe('FcmSender.send: access token', () => {
  it('mints one access token for a cold fan-out, not one per device', async () => {
    const google = fakeGoogle(ok);
    const sender = new FcmSender(config, google.fetchImpl);
    await Promise.all(['a1', 'a2', 'a3'].map((token) => sender.send(device(token), payload)));

    assert.equal(google.oauthCalls().length, 1);
    assert.equal(google.fcmCalls().length, 3);
  });

  it('lets a failed mint be retried rather than caching the failure', async () => {
    let fail = true;
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url) === OAUTH_URL) {
        if (fail) {
          fail = false;
          return new Response('nope', { status: 500 });
        }
        return Response.json({ access_token: 'ya29.ok' });
      }
      return ok();
    }) as typeof fetch;
    const sender = new FcmSender(config, fetchImpl);

    await assert.rejects(sender.send(device(), payload), /Google OAuth 500/);
    await sender.send(device(), payload);
  });

  it('drops an access token FCM rejects (401) and retries once with a fresh one', async () => {
    const google = fakeGoogle((init) =>
      new Headers(init.headers).get('authorization') === 'Bearer ya29.1'
        ? fcmError(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.', 'UNAUTHENTICATED')
        : ok()
    );
    const sender = new FcmSender(config, google.fetchImpl);

    await sender.send(device(), payload);
    assert.equal(google.oauthCalls().length, 2);
    assert.equal(google.fcmCalls().length, 2);

    // And the fresh token is the one cached from then on.
    await sender.send(device(), payload);
    assert.equal(google.oauthCalls().length, 2);
  });

  it('reports a 401 that a fresh token does not cure, without looping', async () => {
    const google = fakeGoogle(() =>
      fcmError(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.', 'UNAUTHENTICATED')
    );
    const sender = new FcmSender(config, google.fetchImpl);

    await assert.rejects(sender.send(device(), payload), /FCM 401/);
    assert.equal(google.fcmCalls().length, 2);
  });
});

describe('FcmSender.send: error classification', () => {
  it('prunes UNREGISTERED (404)', async () => {
    const google = fakeGoogle(() =>
      fcmError(404, 'NOT_FOUND', 'Requested entity was not found.', 'UNREGISTERED')
    );
    await assert.rejects(new FcmSender(config, google.fetchImpl).send(device(), payload), TokenExpiredError);
  });

  it('prunes a registration token FCM calls invalid (400 INVALID_ARGUMENT on message.token)', async () => {
    const google = fakeGoogle(() =>
      fcmError(
        400,
        'INVALID_ARGUMENT',
        'The registration token is not a valid FCM registration token',
        'INVALID_ARGUMENT',
        [
          {
            '@type': 'type.googleapis.com/google.rpc.BadRequest',
            fieldViolations: [
              {
                field: 'message.token',
                description: 'The registration token is not a valid FCM registration token'
              }
            ]
          }
        ]
      )
    );
    const error = await new FcmSender(config, google.fetchImpl)
      .send(device(), payload)
      .then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof TokenExpiredError);
    assert.match(error.reason ?? '', /not a valid FCM registration token/);
  });

  it('keeps the token when INVALID_ARGUMENT is about the payload, which is our bug', async () => {
    const google = fakeGoogle(() =>
      fcmError(400, 'INVALID_ARGUMENT', 'Invalid data payload key: from', 'INVALID_ARGUMENT')
    );
    const error = await new FcmSender(config, google.fetchImpl)
      .send(device(), payload)
      .then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof Error);
    assert.equal(error instanceof TokenExpiredError, false);
    assert.match(error.message, /FCM 400/);
  });

  it('prunes a token from another Firebase project (403 SENDER_ID_MISMATCH)', async () => {
    const google = fakeGoogle(() =>
      fcmError(403, 'PERMISSION_DENIED', 'SenderId mismatch', 'SENDER_ID_MISMATCH')
    );
    const error = await new FcmSender(config, google.fetchImpl)
      .send(device(), payload)
      .then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof TokenExpiredError);
    assert.match(error.reason ?? '', /SENDER_ID_MISMATCH/);
  });

  it('keeps the token on a 403 that is about our credentials, not the token', async () => {
    const google = fakeGoogle(() =>
      fcmError(403, 'PERMISSION_DENIED', 'Permission cloudmessaging.messages.create denied', 'THIRD_PARTY_AUTH_ERROR')
    );
    await assert.rejects(
      new FcmSender(config, google.fetchImpl).send(device(), payload),
      (error: unknown) => error instanceof Error && !(error instanceof TokenExpiredError)
    );
  });

  it('keeps the token on a transient failure', async () => {
    const google = fakeGoogle(() => fcmError(503, 'UNAVAILABLE', 'The service is unavailable.', 'UNAVAILABLE'));
    await assert.rejects(
      new FcmSender(config, google.fetchImpl).send(device(), payload),
      (error: unknown) => error instanceof Error && !(error instanceof TokenExpiredError)
    );
  });
});
