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

  it('reports the native call ended, as declined, when a reject is buffered', () => {
    const host = createHost();
    const registry = new CallRegistry({ host, fusionTimeoutMs: 1000 });
    const uuid = registry.reportIncomingPush({ callId: 'c1' });
    registry.applyIntent(uuid, 'reject');

    host.clock.value += 1001;
    registry.tick();

    expect(host.reportCallEnded).toHaveBeenCalledWith(uuid, 'declined');
    expect(host.reportCallEnded).not.toHaveBeenCalledWith(uuid, 'missed');
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

    it('refuses to bind a push the user answered and then ended', () => {
      // The user pressed End in CallKit while the bridge call was being
      // placed. The entry stays 'pending-push' with a buffered reject (an
      // inbound call that still arrives must be turned down, not ring again),
      // but the call is over: binding would bridge the user to the caller with
      // a live microphone and no native UI.
      const host = createHost();
      const registry = new CallRegistry({ host });
      const uuid = registry.reportIncomingPush({ callId: 'a-leg-sid' });
      registry.applyIntent(uuid, 'answer');
      registry.applyIntent(uuid, 'reject');

      expect(registry.bindCall(uuid, createCall('bridge-leg') as never)).toBe(false);
      expect(registry.entryForUuid(uuid)?.intent).toBe('reject');
    });
  });

  describe('isLive', () => {
    it('is true for a ringing, answered or connected entry', () => {
      const registry = new CallRegistry({ host: createHost() });
      const ringing = registry.reportIncomingPush({ callId: 'c1' });
      const answered = registry.reportIncomingPush({ callId: 'c2' });
      registry.applyIntent(answered, 'answer');
      const outbound = registry.attachOutgoingCall(createCall('c3') as never, 'h', 'n');

      expect([ringing, answered, outbound].map((uuid) => registry.isLive(uuid))).toEqual([
        true,
        true,
        true
      ]);
    });

    it('is false for an ended entry, an unknown uuid and a push the user ended', () => {
      const registry = new CallRegistry({ host: createHost() });
      const ended = registry.reportIncomingPush({ callId: 'c1' });
      registry.endCall(ended);
      const rejected = registry.reportIncomingPush({ callId: 'c2' });
      registry.applyIntent(rejected, 'reject');

      expect([ended, 'unknown', rejected].map((uuid) => registry.isLive(uuid))).toEqual([
        false,
        false,
        false
      ]);
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

describe('CallRegistry — UUID case', () => {
  // callkeep's iOS module reports every CallKit action with
  // `[action.callUUID.UUIDString lowercaseString]`, while a PushKit display
  // (or the cached launch push) carries the UUID as the push or
  // `[[NSUUID UUID] UUIDString]` spelled it: upper-case.
  const UPPER = 'E621E1F8-C36C-495A-93FC-0C247A3E6E5F';
  const LOWER = UPPER.toLowerCase();

  it('applies a lower-cased native answer to an entry adopted upper-case', () => {
    const registry = new CallRegistry({ host: createHost() });
    registry.adoptNativeEntry({ uuid: UPPER, callId: 'c1' });
    const asked: string[] = [];
    registry.answerRequested$.subscribe((entry) => asked.push(entry.uuid));

    registry.applyIntent(LOWER, 'answer');

    expect(asked).toEqual([LOWER]);
    expect(registry.entryForUuid(LOWER)?.intent).toBe('answer');
    expect(registry.entryForUuid(UPPER)).toBe(registry.entryForUuid(LOWER));
    expect(registry.isLive(LOWER)).toBe(true);
  });

  it('keeps one entry when the same call is adopted in either case', () => {
    const registry = new CallRegistry({ host: createHost() });
    registry.adoptNativeEntry({ uuid: UPPER, callId: 'c1' });
    registry.adoptNativeEntry({ uuid: LOWER, data: { bridgeToken: 't' } });

    expect(registry.entries).toHaveLength(1);
    expect(registry.entries[0]?.data).toEqual({ bridgeToken: 't' });
  });

  it('ends an upper-case entry from a lower-cased native end', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });
    registry.adoptNativeEntry({ uuid: UPPER, callId: 'c1' });
    const call = createCall('c1');
    registry.attachIncomingCall(call as never);

    registry.endCall(LOWER);

    expect(call.hangup).toHaveBeenCalled();
    expect(registry.entryForUuid(UPPER)?.state).toBe('ended');
  });

  it('keys an entry the host minted upper-case the way callkeep will report it', () => {
    const host = createHost();
    host.generateUuid.mockReturnValue(UPPER);
    const registry = new CallRegistry({ host });

    const uuid = registry.reportIncomingPush({ callId: 'c1' });

    expect(uuid).toBe(LOWER);
    expect(host.displayIncomingCall).toHaveBeenCalledWith(LOWER, 'Unknown', 'Unknown caller');
  });
});

describe('CallRegistry — a push for a call that is already here', () => {
  it('does not show a second call when the push follows its SDK invite', () => {
    // Fusion topology, app in the foreground: the websocket invite wins the
    // race and the push for the same call id arrives after it.
    const host = createHost();
    const registry = new CallRegistry({ host });
    const call = createCall('c1');
    registry.attachIncomingCall(call as never);
    const fused = registry.uuidForCall(call as never);

    const uuid = registry.reportIncomingPush({ callId: 'c1' });

    expect(uuid).toBe(fused);
    expect(registry.entries).toHaveLength(1);
    expect(host.displayIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('does not ring again for a push whose call has already ended', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });
    const call = createCall('c1');
    registry.attachIncomingCall(call as never);
    const fused = registry.uuidForCall(call as never)!;
    registry.reportRemoteEnded(fused);

    expect(registry.reportIncomingPush({ callId: 'c1' })).toBe(fused);
    expect(host.displayIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('ends a native display that duplicates a call already fused', () => {
    // iOS: PushKit reported the push to CallKit natively (a second CallKit
    // call, which iOS shows as call waiting) after the SDK invite was shown.
    const host = createHost();
    const registry = new CallRegistry({ host });
    const call = createCall('c1');
    registry.attachIncomingCall(call as never);
    const fused = registry.uuidForCall(call as never)!;

    registry.adoptNativeEntry({ uuid: 'native-dup', callId: 'c1' });

    expect(host.reportCallEnded).toHaveBeenCalledWith('native-dup', 'duplicate');
    expect(registry.isLive('native-dup')).toBe(false);
    expect(registry.entryForUuid(fused)?.call).toBe(call);
    // The duplicate is not offered to the app to answer or draw.
    expect(registry.entries.filter((entry) => registry.isLive(entry.uuid))).toHaveLength(1);
  });
});

describe('CallRegistry — one answer, one call', () => {
  it('asks once for an answer, not again for a subscriber that mounts while it is dialled', () => {
    // A re-subscription during the dial (an effect whose deps change, a
    // second screen with the same recipe, StrictMode's double mount) replayed
    // the entry, and a second dial raced the first.
    const registry = new CallRegistry({ host: createHost() });
    const first: string[] = [];
    registry.answerRequested$.subscribe((entry) => first.push(entry.uuid));
    const uuid = registry.reportIncomingPush({ callId: 'c1' });
    registry.applyIntent(uuid, 'answer');

    const second: string[] = [];
    registry.answerRequested$.subscribe((entry) => second.push(entry.uuid));

    expect(first).toEqual([uuid]);
    expect(second).toEqual([]);
  });

  it('replays an answer that reached no subscriber to the first one only', () => {
    const registry = new CallRegistry({ host: createHost() });
    const uuid = registry.reportIncomingPush({ callId: 'c1' });
    registry.applyIntent(uuid, 'answer');

    const first: string[] = [];
    registry.answerRequested$.subscribe((entry) => first.push(entry.uuid));
    const second: string[] = [];
    registry.answerRequested$.subscribe((entry) => second.push(entry.uuid));

    expect(first).toEqual([uuid]);
    expect(second).toEqual([]);
  });

  it('asks for one call when the same push is answered twice', () => {
    const registry = new CallRegistry({ host: createHost() });
    const asked: string[] = [];
    registry.answerRequested$.subscribe((entry) => asked.push(entry.uuid));
    const uuid = registry.reportIncomingPush({ callId: 'c1' });

    registry.applyIntent(uuid, 'answer');
    registry.applyIntent(uuid, 'answer');

    expect(asked).toEqual([uuid]);
  });

  it('refuses a second call for an entry already bound to a live one', () => {
    const registry = new CallRegistry({ host: createHost() });
    const uuid = registry.reportIncomingPush({ callId: 'c1' });
    registry.applyIntent(uuid, 'answer');
    const a = createCall('bridge-a');
    const b = createCall('bridge-b');

    expect(registry.bindCall(uuid, a as never)).toBe(true);
    expect(registry.bindCall(uuid, b as never)).toBe(false);

    expect(registry.entryForUuid(uuid)?.call).toBe(a);
    expect(registry.uuidForCall(b as never)).toBeUndefined();
  });
});

describe('CallRegistry — a decline with no SDK call', () => {
  // The bridge topology: the caller is parked and no SDK call will ever fuse,
  // so a buffered reject reached nobody and the caller heard ringback for the
  // whole park window. The app must be told, so it can tell its server.
  it('asks the app to turn the call down when a push with no call is declined', () => {
    const registry = new CallRegistry({ host: createHost() });
    const uuid = registry.reportIncomingPush({ data: { bridgeToken: 'tok' } });
    const declined: Array<Record<string, string> | undefined> = [];
    registry.rejectRequested$.subscribe((entry) => declined.push(entry.data));

    registry.applyIntent(uuid, 'reject');

    expect(declined).toEqual([{ bridgeToken: 'tok' }]);
  });

  it('replays a decline made before anything subscribed, once', () => {
    // Cold start: the user declines on the lock screen while React mounts.
    const registry = new CallRegistry({ host: createHost() });
    const uuid = registry.reportIncomingPush({ data: { bridgeToken: 'tok' } });
    registry.applyIntent(uuid, 'reject');

    const first: string[] = [];
    registry.rejectRequested$.subscribe((entry) => first.push(entry.uuid));
    const second: string[] = [];
    registry.rejectRequested$.subscribe((entry) => second.push(entry.uuid));

    expect(first).toEqual([uuid]);
    expect(second).toEqual([]);
  });

  it('asks again for nothing when the decline is repeated', () => {
    // callkeep echoes an end the app requested back as an endCall action.
    const registry = new CallRegistry({ host: createHost() });
    const uuid = registry.reportIncomingPush({});
    const declined: string[] = [];
    registry.rejectRequested$.subscribe((entry) => declined.push(entry.uuid));

    registry.applyIntent(uuid, 'reject');
    registry.applyIntent(uuid, 'reject');

    expect(declined).toEqual([uuid]);
  });

  it('asks for no decline when the call is already here to reject', () => {
    const registry = new CallRegistry({ host: createHost() });
    const uuid = registry.reportIncomingPush({ callId: 'c1' });
    const call = createCall('c1');
    registry.attachIncomingCall(call as never);
    const declined: string[] = [];
    registry.rejectRequested$.subscribe((entry) => declined.push(entry.uuid));

    registry.applyIntent(uuid, 'reject');

    expect(call.reject).toHaveBeenCalled();
    expect(declined).toEqual([]);
  });

  it('asks for a decline when the user ends an answered push before its call is placed', () => {
    const registry = new CallRegistry({ host: createHost() });
    const uuid = registry.reportIncomingPush({ data: { bridgeToken: 'tok' } });
    const declined: string[] = [];
    registry.rejectRequested$.subscribe((entry) => declined.push(entry.uuid));

    registry.applyIntent(uuid, 'answer');
    registry.applyIntent(uuid, 'reject');

    expect(declined).toEqual([uuid]);
  });
});

describe('CallRegistry — why a call ended', () => {
  it('ends the native call at once, as declined, when a push with no call is declined', () => {
    // Waiting for the fusion deadline left it ringing in Telecom for 45 s
    // after the user declined it in the app, and then reported it as missed.
    const host = createHost();
    const registry = new CallRegistry({ host, fusionTimeoutMs: 1000 });
    const uuid = registry.reportIncomingPush({ callId: 'c1' });

    registry.applyIntent(uuid, 'reject');
    expect(host.reportCallEnded).toHaveBeenCalledWith(uuid, 'declined');

    host.clock.value += 1001;
    registry.tick();

    expect(host.reportCallEnded).toHaveBeenCalledTimes(1);
    expect(registry.entryForUuid(uuid)?.state).toBe('ended');
  });

  it('reports an answered push that never got its call as failed, not missed', () => {
    const host = createHost();
    const registry = new CallRegistry({ host, fusionTimeoutMs: 1000 });
    const uuid = registry.reportIncomingPush({ callId: 'c1' });

    registry.applyIntent(uuid, 'answer');
    host.clock.value += 120_000;
    registry.tick();

    expect(host.reportCallEnded).toHaveBeenCalledWith(uuid, 'failed');
  });

  it('reports an end the app gives as failed as failed', () => {
    // A bridge dial that failed, or an SDK that never connected.
    const host = createHost();
    const registry = new CallRegistry({ host });
    const uuid = registry.reportIncomingPush({ callId: 'c1' });
    registry.applyIntent(uuid, 'answer');

    registry.endCall(uuid, 'failed');

    expect(host.reportCallEnded).toHaveBeenCalledWith(uuid, 'failed');
    expect(registry.entryForUuid(uuid)?.state).toBe('ended');
  });

  it('still reports an ordinary end as local', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });
    const uuid = registry.reportIncomingPush({ callId: 'c1' });

    registry.endCall(uuid);

    expect(host.reportCallEnded).toHaveBeenCalledWith(uuid, 'local');
  });
});

describe('CallRegistry — fusion timeout set after construction', () => {
  it('uses a timeout set later for the pushes reported from then on', () => {
    // getCallKit() builds the registry with no options; setup() is where an
    // app passes fusionTimeoutMs.
    const host = createHost();
    const registry = new CallRegistry({ host });
    registry.setFusionTimeoutMs(30_000);
    const uuid = registry.reportIncomingPush({ callId: 'c1' });

    host.clock.value += 30_001;
    registry.tick();

    expect(registry.entryForUuid(uuid)?.state).toBe('ended');
  });

  it('defaults to 45 seconds', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });
    const uuid = registry.reportIncomingPush({ callId: 'c1' });

    host.clock.value += 45_000;
    registry.tick();
    expect(registry.entryForUuid(uuid)?.state).toBe('pending-push');

    host.clock.value += 1;
    registry.tick();
    expect(registry.entryForUuid(uuid)?.state).toBe('ended');
  });
});

describe('CallRegistry — empty caller names', () => {
  // An empty name is no name: '' from a push's from_name (the support
  // server's POST /notify passes fromName "" through) or an invite's
  // caller_id_name. Kept by '??', it showed as a blank caller in the native UI
  // and the in-app sheet; and with no name at all, 'Unknown caller' hid a
  // number the registry had.
  it('names a push with an empty name by its number', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });

    registry.reportIncomingPush({ callId: 'c1', from: '+15551234', fromName: '' });

    expect(host.displayIncomingCall).toHaveBeenCalledWith('uuid-1', '+15551234', '+15551234');
  });

  it('names a push with no name by its number', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });

    registry.reportIncomingPush({ callId: 'c1', from: '+15551234' });

    expect(registry.entries[0]?.displayName).toBe('+15551234');
  });

  it('names an SDK call with an empty caller name by its number', () => {
    const host = createHost();
    const registry = new CallRegistry({ host });

    registry.attachIncomingCall({ ...createCall('c1'), from: '+15551234', fromName: '' } as never);

    expect(host.displayIncomingCall).toHaveBeenCalledWith('uuid-1', '+15551234', '+15551234');
  });

  it('names an adopted native entry with empty fields by the placeholders', () => {
    const registry = new CallRegistry({ host: createHost() });

    registry.adoptNativeEntry({ uuid: 'native', from: '', fromName: '' });

    expect(registry.entries[0]).toMatchObject({ handle: 'Unknown', displayName: 'Unknown caller' });
  });
});
