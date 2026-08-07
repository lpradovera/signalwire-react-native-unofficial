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
  });
});
