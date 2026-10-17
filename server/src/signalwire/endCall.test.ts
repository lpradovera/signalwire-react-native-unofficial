import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCallEnder } from './endCall.js';

describe('createCallEnder', () => {
  it('sends command "calling.end" with the call under `id`', async () => {
    // `call_id` is answered with 404, which reads as "no such call" rather
    // than "wrong field", and cost an afternoon to tell apart. The bare
    // command "end" is rejected the same way.
    let seen: Record<string, unknown> = {};
    const ender = createCallEnder({
      space: 'example.signalwire.com',
      projectId: 'p',
      apiToken: 't',
      fetchImpl: (async (_url: string, init: { body: string }) => {
        seen = JSON.parse(init.body) as Record<string, unknown>;
        return { ok: true, status: 200, text: async () => '' };
      }) as unknown as typeof fetch
    });

    await ender.end('call-sid-1');

    assert.equal(seen.command, 'calling.end');
    assert.equal(seen.id, 'call-sid-1');
    assert.equal(seen.call_id, undefined, 'call_id is the shape that 404s');
  });

  it('reports failure rather than throwing, so a stranded caller is logged', async () => {
    const ender = createCallEnder({
      space: 'example.signalwire.com',
      projectId: 'p',
      apiToken: 't',
      fetchImpl: (async () => ({
        ok: false,
        status: 404,
        text: async () => 'Not Found'
      })) as unknown as typeof fetch
    });

    const result = await ender.end('gone');
    assert.equal(result.ok, false);
    // The status, so a caller can tell "no such call" from a failure.
    assert.equal(result.ok === false && result.status, 404);
  });

  it('bounds the request, and reports a stalled one as a failure', async () => {
    // Off the park path, but a hung REST call here strands the caller just
    // the same, and nothing else would ever end it.
    let signal: AbortSignal | null | undefined;
    const ender = createCallEnder({
      space: 'example.signalwire.com',
      projectId: 'p',
      apiToken: 't',
      timeoutMs: 50,
      fetchImpl: ((_url: string, init: RequestInit) => {
        signal = init.signal;
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
      }) as unknown as typeof fetch
    });

    const result = await ender.end('stalled');

    assert.ok(signal instanceof AbortSignal);
    assert.equal(result.ok, false);
  });

  it('puts the reason under params, where the Calling API schema has it (server-32)', async () => {
    // Calling.CallHangupRequest: { id, params: { reason } }, both required.
    let seen: Record<string, unknown> = {};
    const ender = createCallEnder({
      space: 'example.signalwire.com',
      projectId: 'p',
      apiToken: 't',
      fetchImpl: (async (_url: string, init: { body: string }) => {
        seen = JSON.parse(init.body) as Record<string, unknown>;
        return { ok: true, status: 200, text: async () => '' };
      }) as unknown as typeof fetch
    });

    await ender.end('call-sid-1', 'decline');

    assert.deepEqual(seen, { command: 'calling.end', id: 'call-sid-1', params: { reason: 'decline' } });
  });

  for (const space of ['https://example.signalwire.com', 'example.signalwire.com/', 'http://example.signalwire.com/']) {
    it(`reaches the space host when SIGNALWIRE_SPACE is written "${space}" (server-5)`, async () => {
      // The subscriber-token minter accepts these forms; the ender built
      // https://https://... and every calling.end went to host "https".
      let url = '';
      const ender = createCallEnder({
        space,
        projectId: 'p',
        apiToken: 't',
        fetchImpl: (async (target: string) => {
          url = target;
          return { ok: true, status: 200, text: async () => '' };
        }) as unknown as typeof fetch
      });

      await ender.end('call-sid-1');

      assert.equal(url, 'https://example.signalwire.com/api/calling/calls');
    });
  }
});
