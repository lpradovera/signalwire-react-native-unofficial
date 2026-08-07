import { CallRegistry } from './CallRegistry';

import type { CallRegistryHost } from './types';

type TestHost = jest.Mocked<CallRegistryHost> & { clock: { value: number } };

function createHost(): TestHost {
  const clock = { value: 1000 };
  let counter = 0;
  return Object.assign(
    {
      displayIncomingCall: jest.fn(),
      startOutgoingCall: jest.fn(),
      reportOutgoingConnected: jest.fn(),
      reportCallEnded: jest.fn(),
      generateUuid: jest.fn(() => `uuid-${++counter}`),
      now: jest.fn(() => clock.value)
    },
    { clock }
  ) as unknown as TestHost;
}

function createCall(id: string) {
  return {
    id,
    answer: jest.fn(),
    reject: jest.fn(),
    hangup: jest.fn(async () => undefined)
  };
}

describe('CallRegistry — push path', () => {
  it('reports to the native UI immediately and returns the uuid', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });

    const uuid = registry.reportIncomingPush({ callId: 'c1', from: '+15551234', fromName: 'Ada' });

    expect(uuid).toBe('uuid-1');
    expect(host.displayIncomingCall).toHaveBeenCalledWith('uuid-1', '+15551234', 'Ada');
    expect(registry.entryForUuid(uuid)?.state).toBe('pending-push');
  });

  it('falls back to a placeholder handle when the payload omits from', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });
    registry.reportIncomingPush({ callId: 'c1' });
    expect(host.displayIncomingCall).toHaveBeenCalledWith('uuid-1', 'Unknown', 'Unknown caller');
  });

  it('fuses an arriving call by exact id match', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });
    const uuid = registry.reportIncomingPush({ callId: 'c1' });

    const call = createCall('c1');
    registry.attachIncomingCall(call as never);

    const entry = registry.entryForUuid(uuid);
    expect(entry?.state).toBe('fused');
    expect(entry?.call).toBe(call);
    expect(host.displayIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('does not fuse a call whose id matches nothing, creating a new entry instead', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });
    registry.reportIncomingPush({ callId: 'c1' });

    registry.attachIncomingCall(createCall('other') as never);

    expect(registry.entries).toHaveLength(2);
    expect(host.displayIncomingCall).toHaveBeenCalledTimes(2);
  });

  it('fuses a payload-less push with the single unmatched inbound call', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });
    const uuid = registry.reportIncomingPush({ from: '+15551234' });

    registry.attachIncomingCall(createCall('c1') as never);

    expect(registry.entryForUuid(uuid)?.state).toBe('fused');
    expect(registry.entries).toHaveLength(1);
  });

  it('refuses the ambiguous fallback when two payload-less pushes are pending', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });
    registry.reportIncomingPush({});
    registry.reportIncomingPush({});

    registry.attachIncomingCall(createCall('c1') as never);

    expect(registry.entries).toHaveLength(3);
    expect(registry.entries.filter((entry) => entry.state === 'pending-push')).toHaveLength(2);
  });

  it('ends a pending entry as missed once the fusion deadline passes', () => {
    const host = createHost();
    const registry = new CallRegistry({ host, fusionTimeoutMs: 5000 });
    const uuid = registry.reportIncomingPush({ callId: 'c1' });

    host.clock.value += 5001;
    registry.tick();

    expect(host.reportCallEnded).toHaveBeenCalledWith(uuid, 'missed');
    expect(registry.entryForUuid(uuid)?.state).toBe('ended');
  });

  it('leaves a pending entry alone before the deadline', () => {
    const host = createHost();
    const registry = new CallRegistry({ host, fusionTimeoutMs: 5000 });
    registry.reportIncomingPush({ callId: 'c1' });

    host.clock.value += 4999;
    registry.tick();

    expect(host.reportCallEnded).not.toHaveBeenCalled();
  });

  it('never expires a fused entry', () => {
    const host = createHost();
    const registry = new CallRegistry({ host, fusionTimeoutMs: 5000 });
    registry.reportIncomingPush({ callId: 'c1' });
    registry.attachIncomingCall(createCall('c1') as never);

    host.clock.value += 60000;
    registry.tick();

    expect(host.reportCallEnded).not.toHaveBeenCalled();
  });

  it('ignores a duplicate push for the same call id', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });
    const first = registry.reportIncomingPush({ callId: 'c1' });
    const second = registry.reportIncomingPush({ callId: 'c1' });

    expect(second).toBe(first);
    expect(host.displayIncomingCall).toHaveBeenCalledTimes(1);
  });
});

describe('CallRegistry — intent buffering', () => {
  it('answers immediately when the entry is already fused', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });
    const uuid = registry.reportIncomingPush({ callId: 'c1' });
    const call = createCall('c1');
    registry.attachIncomingCall(call as never);

    registry.applyIntent(uuid, 'answer');

    expect(call.answer).toHaveBeenCalled();
  });

  it('buffers an answer taken while still pending and applies it on fusion', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });
    const uuid = registry.reportIncomingPush({ callId: 'c1' });

    registry.applyIntent(uuid, 'answer');
    expect(registry.entryForUuid(uuid)?.intent).toBe('answer');

    const call = createCall('c1');
    registry.attachIncomingCall(call as never);

    expect(call.answer).toHaveBeenCalled();
    expect(registry.entryForUuid(uuid)?.intent).toBeNull();
  });

  it('buffers a reject and applies it on fusion', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });
    const uuid = registry.reportIncomingPush({ callId: 'c1' });

    registry.applyIntent(uuid, 'reject');
    const call = createCall('c1');
    registry.attachIncomingCall(call as never);

    expect(call.reject).toHaveBeenCalled();
    expect(call.answer).not.toHaveBeenCalled();
  });

  it('lets a later intent replace an earlier buffered one', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });
    const uuid = registry.reportIncomingPush({ callId: 'c1' });

    registry.applyIntent(uuid, 'answer');
    registry.applyIntent(uuid, 'reject');

    const call = createCall('c1');
    registry.attachIncomingCall(call as never);

    expect(call.reject).toHaveBeenCalled();
    expect(call.answer).not.toHaveBeenCalled();
  });

  it('ignores an intent for an unknown uuid', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });
    expect(() => registry.applyIntent('nope', 'answer')).not.toThrow();
  });

  it('reports the call ended when a buffered reject expires unfused', () => {
    const host = createHost();
    const registry = new CallRegistry({ host, fusionTimeoutMs: 1000 });
    const uuid = registry.reportIncomingPush({ callId: 'c1' });
    registry.applyIntent(uuid, 'reject');

    host.clock.value += 1001;
    registry.tick();

    expect(host.reportCallEnded).toHaveBeenCalledWith(uuid, 'missed');
  });
});

describe('CallRegistry — in-app inbound and outbound', () => {
  it('creates a fused entry and shows native UI for an in-app inbound call', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });

    registry.attachIncomingCall(createCall('c1') as never);

    expect(host.displayIncomingCall).toHaveBeenCalledWith('uuid-1', 'Unknown', 'Unknown caller');
    expect(registry.entryForUuid('uuid-1')?.state).toBe('fused');
  });

  it('does not duplicate an already-attached call', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });
    const call = createCall('c1');

    registry.attachIncomingCall(call as never);
    registry.attachIncomingCall(call as never);

    expect(registry.entries).toHaveLength(1);
  });

  it('starts an outgoing native call for a dial', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });

    const uuid = registry.attachOutgoingCall(createCall('c1') as never, '/public/room', 'Support');

    expect(host.startOutgoingCall).toHaveBeenCalledWith(uuid, '/public/room', 'Support');
    expect(registry.entryForUuid(uuid)?.state).toBe('fused');
  });

  it('maps a call back to its uuid', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });
    const call = createCall('c1');
    const uuid = registry.attachOutgoingCall(call as never, '/public/room', 'Support');

    expect(registry.uuidForCall(call as never)).toBe(uuid);
  });

  it('reports an outgoing call connected', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });
    const uuid = registry.attachOutgoingCall(createCall('c1') as never, '/public/room', 'Support');

    registry.reportConnected(uuid);

    expect(host.reportOutgoingConnected).toHaveBeenCalledWith(uuid);
  });
});

describe('CallRegistry — ending', () => {
  it('hangs up a fused call and reports it ended locally', async () => {
    const host = createHost();
    const registry = new CallRegistry({ host });
    const call = createCall('c1');
    const uuid = registry.attachOutgoingCall(call as never, '/public/room', 'Support');

    registry.endCall(uuid);
    await Promise.resolve();

    expect(call.hangup).toHaveBeenCalled();
    expect(registry.entryForUuid(uuid)?.state).toBe('ended');
  });

  it('reports a remotely-ended call to the native UI', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });
    const uuid = registry.attachOutgoingCall(createCall('c1') as never, '/public/room', 'Support');

    registry.reportRemoteEnded(uuid);

    expect(host.reportCallEnded).toHaveBeenCalledWith(uuid, 'remote');
    expect(registry.entryForUuid(uuid)?.state).toBe('ended');
  });

  it('ending an already-ended call is a no-op', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });
    const uuid = registry.attachOutgoingCall(createCall('c1') as never, '/public/room', 'Support');

    registry.reportRemoteEnded(uuid);
    registry.reportRemoteEnded(uuid);

    expect(host.reportCallEnded).toHaveBeenCalledTimes(1);
  });

  it('emits the entry list on every change', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });
    const snapshots: number[] = [];
    const subscription = registry.entries$.subscribe((entries) => snapshots.push(entries.length));

    registry.reportIncomingPush({ callId: 'c1' });
    registry.attachIncomingCall(createCall('c1') as never);

    subscription.unsubscribe();
    expect(snapshots).toEqual([0, 1, 1]);
  });

  it('destroy completes the entries stream', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });
    const completed = jest.fn();
    registry.entries$.subscribe({ complete: completed });

    registry.destroy();

    expect(completed).toHaveBeenCalled();
  });

  it('answers from the native UI audio-only, never letting SDK defaults add video', () => {
    // An SDP answer cannot introduce an m-line the offer lacks; a bare
    // answer() let the SDK request video against audio-only offers and the
    // answer failed after the user had already accepted on the lock screen.
    const host = createHost();
    const registry = new CallRegistry({ host });
    const call = createCall('c1');
    const uuid = registry.reportIncomingPush({ callId: 'c1' });
    registry.attachIncomingCall(call as never);

    registry.applyIntent(uuid, 'answer');

    expect(call.answer).toHaveBeenCalledWith({ audio: true, video: false });
  });

  it('emits on answered$ when a native answer runs', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });
    const call = createCall('c1');
    registry.attachIncomingCall(call as never);
    const uuid = registry.uuidForCall(call as never)!;
    const answered: unknown[] = [];
    registry.answered$.subscribe((c) => answered.push(c));

    registry.applyIntent(uuid, 'answer');

    expect(answered).toEqual([call]);
  });

  it('emits on answered$ when a buffered lock-screen answer fuses later', () => {
    // Cold-start shape: the user answers the push before the SDK call exists.
    const host = createHost();
    const registry = new CallRegistry({ host });
    const uuid = registry.reportIncomingPush({ callId: 'c1' });
    registry.applyIntent(uuid, 'answer');
    const answered: unknown[] = [];
    registry.answered$.subscribe((c) => answered.push(c));

    const call = createCall('c1');
    registry.attachIncomingCall(call as never);

    expect(answered).toEqual([call]);
  });

  describe('bridge flow — the caller is parked and we place the joining call', () => {
    it('carries opaque push data through to the answer request', () => {
      // The app needs whatever the server sent — a single-use bridge token,
      // for instance — at the moment the user answers.
      const host = createHost();
      const registry = new CallRegistry({ host });
      const uuid = registry.reportIncomingPush({
        from: '+15551234',
        data: { bridgeToken: 'opaque-single-use' }
      });
      const seen: Array<Record<string, string> | undefined> = [];
      registry.answerRequested$.subscribe((entry) => seen.push(entry.data));

      registry.applyIntent(uuid, 'answer');

      expect(seen).toEqual([{ bridgeToken: 'opaque-single-use' }]);
    });

    it('asks for a call when the user answers a push that has none', () => {
      const host = createHost();
      const registry = new CallRegistry({ host });
      const uuid = registry.reportIncomingPush({ callId: 'a-leg-sid' });
      const asked: string[] = [];
      registry.answerRequested$.subscribe((entry) => asked.push(entry.uuid));

      registry.applyIntent(uuid, 'answer');

      // Nothing is coming to fuse with: the app must place the call itself.
      expect(asked).toEqual([uuid]);
    });

    it('does not ask for a call when the user declines', () => {
      const host = createHost();
      const registry = new CallRegistry({ host });
      const uuid = registry.reportIncomingPush({ callId: 'a-leg-sid' });
      const asked: string[] = [];
      registry.answerRequested$.subscribe((entry) => asked.push(entry.uuid));

      registry.applyIntent(uuid, 'reject');

      expect(asked).toEqual([]);
    });

    it('binds the placed call to the same native entry, not a second one', () => {
      const host = createHost();
      const registry = new CallRegistry({ host });
      const uuid = registry.reportIncomingPush({ callId: 'a-leg-sid' });
      registry.applyIntent(uuid, 'answer');
      const call = createCall('bridge-leg');

      expect(registry.bindCall(uuid, call as never)).toBe(true);

      // A second UUID would leave the original entry ringing forever.
      expect(registry.entries).toHaveLength(1);
      expect(registry.uuidForCall(call as never)).toBe(uuid);
      expect(registry.entryForUuid(uuid)?.state).toBe('fused');
    });

    it('does not replay the answer intent against the call it created', () => {
      // The user's answer is why this call exists; answering it would be
      // answering an outbound leg that was never ringing.
      const host = createHost();
      const registry = new CallRegistry({ host });
      const uuid = registry.reportIncomingPush({ callId: 'a-leg-sid' });
      registry.applyIntent(uuid, 'answer');
      const call = createCall('bridge-leg');

      registry.bindCall(uuid, call as never);

      expect(call.answer).not.toHaveBeenCalled();
      expect(registry.entryForUuid(uuid)?.intent).toBeNull();
    });

    it('refuses to bind when the entry is already gone', () => {
      // The parked caller hung up, or the user declined, while we were dialing.
      const host = createHost();
      const registry = new CallRegistry({ host });
      const uuid = registry.reportIncomingPush({ callId: 'a-leg-sid' });
      registry.endCall(uuid);

      expect(registry.bindCall(uuid, createCall('bridge-leg') as never)).toBe(false);
    });
  });

  it('replays an answer to a subscriber that mounts after it', () => {
    // The cold-start order: push launches the app, the user answers from the
    // lock screen, and the intent is applied while React is still mounting.
    // A plain Subject drops that, so nothing dials the bridge and the caller
    // waits on a parked leg until it times out.
    const registry = new CallRegistry({ host: createHost() });
    const uuid = registry.reportIncomingPush({ callId: 'c1' });
    registry.applyIntent(uuid, 'answer');

    const seen: string[] = [];
    registry.answerRequested$.subscribe((entry) => seen.push(entry.uuid));

    expect(seen).toEqual([uuid]);
  });

  it('does not replay once a call has been bound', () => {
    // Otherwise a later subscriber redials a bridge that already exists.
    const registry = new CallRegistry({ host: createHost() });
    const uuid = registry.reportIncomingPush({ callId: 'c1' });
    registry.applyIntent(uuid, 'answer');
    registry.bindCall(uuid, createCall('c1') as never);

    const seen: string[] = [];
    registry.answerRequested$.subscribe((entry) => seen.push(entry.uuid));

    expect(seen).toEqual([]);
  });

  it('does not replay an ended entry', () => {
    const registry = new CallRegistry({ host: createHost() });
    const uuid = registry.reportIncomingPush({ callId: 'c1' });
    registry.applyIntent(uuid, 'answer');
    registry.endCall(uuid);

    const seen: string[] = [];
    registry.answerRequested$.subscribe((entry) => seen.push(entry.uuid));

    expect(seen).toEqual([]);
  });

  it('still delivers live answers to an existing subscriber', () => {
    const registry = new CallRegistry({ host: createHost() });
    const seen: string[] = [];
    registry.answerRequested$.subscribe((entry) => seen.push(entry.uuid));

    const uuid = registry.reportIncomingPush({ callId: 'c2' });
    registry.applyIntent(uuid, 'answer');

    expect(seen).toEqual([uuid]);
  });

  it('does not expire an entry the user has already answered', () => {
    // The fusion deadline asks "did an inbound SDK call arrive?". Once the
    // user answers a bridge push, no inbound call is coming — the app dials
    // out, which takes a token round-trip, a dial and ICE. Letting the
    // original clock run tore the entry down mid-dial and reported the
    // accepted call as missed.
    const host = createHost();
    const registry = new CallRegistry({ host, fusionTimeoutMs: 1000 });
    const uuid = registry.reportIncomingPush({ callId: 'c1' });

    registry.applyIntent(uuid, 'answer');
    host.clock.value += 5000;
    registry.tick();

    expect(registry.entryForUuid(uuid)?.state).toBe('pending-push');
  });

  it('still gives up on an answered entry that never gets its call', () => {
    // Otherwise a failed dial leaves a native entry ringing forever.
    const host = createHost();
    const registry = new CallRegistry({ host, fusionTimeoutMs: 1000 });
    const uuid = registry.reportIncomingPush({ callId: 'c1' });

    registry.applyIntent(uuid, 'answer');
    host.clock.value += 120_000;
    registry.tick();

    expect(registry.entryForUuid(uuid)?.state).toBe('ended');
  });
});
