import assert from 'node:assert/strict';
import { test } from 'node:test';

import { requestServerToken, ServerTokenError } from './serverToken';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function answering(status: number, body: string, contentType = 'application/json'): FetchLike {
  return async () => new Response(body, { status, headers: { 'content-type': contentType } });
}

test('returns the token and the reference the server minted it for', async () => {
  const fetch = answering(200, JSON.stringify({ token: 'tok', reference: 'alice' }));
  assert.deepEqual(await requestServerToken('http://mac/token', 'rn-example', { fetch }), {
    token: 'tok',
    reference: 'alice'
  });
});

test('passes on the expiry the server reports, for fetchToken renewal', async () => {
  const fetch = answering(200, JSON.stringify({ token: 'tok', reference: 'alice', expires_at: 1_800_000_000 }));
  assert.deepEqual(await requestServerToken('http://mac/token', 'rn-example', { fetch }), {
    token: 'tok',
    reference: 'alice',
    expiresAt: 1_800_000_000
  });
});

test('reports a refusal with its status, so a 401 is not retried', async () => {
  const fetch = answering(401, JSON.stringify({ error: 'unknown subscriber' }));
  await assert.rejects(requestServerToken('http://mac/token', 'rn-example', { fetch }), (error) => {
    assert.ok(error instanceof ServerTokenError);
    assert.equal(error.status, 401);
    return true;
  });
});

test('sends the requested reference', async () => {
  let sent: unknown;
  const fetch: FetchLike = async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ token: 'tok', reference: 'rn-example' }), { status: 200 });
  };
  await requestServerToken('http://mac/token', 'rn-example', { fetch });
  assert.deepEqual(sent, { reference: 'rn-example' });
});

test('falls back to the requested reference when the server names none', async () => {
  const fetch = answering(200, JSON.stringify({ token: 'tok' }));
  const result = await requestServerToken('http://mac/token', 'rn-example', { fetch });
  assert.equal(result.reference, 'rn-example');
});

// A tunnel or proxy in front of a stopped server answers with an HTML page.
// Parsing that first reported "Unexpected token '<'" instead of the status.
test('reports the status of a non-JSON error page', async () => {
  const fetch = answering(502, '<html><body>Bad Gateway</body></html>', 'text/html');
  await assert.rejects(requestServerToken('http://mac/token', 'rn-example', { fetch }), {
    message: 'Token server returned 502'
  });
});

test("reports the server's own error message when it sends one", async () => {
  const fetch = answering(401, JSON.stringify({ error: 'Unauthorized' }));
  await assert.rejects(requestServerToken('http://mac/token', 'rn-example', { fetch }), {
    message: 'Token server returned 401: Unauthorized'
  });
});

test('rejects a 200 that carries no token', async () => {
  const fetch = answering(200, JSON.stringify({}));
  await assert.rejects(requestServerToken('http://mac/token', 'rn-example', { fetch }), {
    message: 'Token server returned no token'
  });
});

// React Native's Android client has no timeout of its own: a dropped SYN
// waited for the OS's TCP connect timeout behind a spinner.
test('gives up after the timeout', async () => {
  const fetch: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  await assert.rejects(
    requestServerToken('http://mac/token', 'rn-example', { fetch, timeoutMs: 20 }),
    { message: 'Token server did not answer within 0.02 s' }
  );
});
