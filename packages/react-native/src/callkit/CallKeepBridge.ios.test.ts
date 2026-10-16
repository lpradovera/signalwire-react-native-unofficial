/**
 * iOS-specific bridge behaviour: the audio-session gate and the fusion tick
 * timer. Both are safety-critical and neither is exercised by the main bridge
 * suite, which runs with `Platform.OS === 'android'`.
 */
import InCallManager from 'react-native-incall-manager';
import RNCallKeep from 'react-native-callkeep';
import { Subject } from 'rxjs';

import { getAudioRouteController, resetAudioRouteControllerForTesting } from '../audio/AudioRouteController';
import { CallKeepBridge } from './CallKeepBridge';

const nativeModules: { SignalWireVoipPush?: Record<string, unknown> } = {};
// The audio controller checks that incall-manager's native module is linked.
Object.assign(nativeModules, { InCallManager: { start: () => undefined } });
jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  get NativeModules() {
    return nativeModules;
  }
}));

const callkeep = RNCallKeep as unknown as typeof RNCallKeep & {
  __emit: (event: string, payload: unknown) => void;
  __reset: () => void;
};

function createCall(id: string) {
   
  const { BehaviorSubject } = require('rxjs') as typeof import('rxjs');
  const status$ = new BehaviorSubject('ringing');
  return {
    id,
    from: '+15551234',
    fromName: 'Ada',
    status$,
    status: 'ringing',
    answer: jest.fn(),
    reject: jest.fn(),
    hangup: jest.fn(async () => undefined),
    toggleHold: jest.fn(async () => undefined),
    sendDigits: jest.fn(async () => undefined),
    self: { mute: jest.fn(), unmute: jest.fn() }
  };
}

/** Lets the bridge's promise chain settle under fake timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe('CallKeepBridge on iOS — the audio-session gate', () => {
  let bridge: CallKeepBridge;

  beforeEach(async () => {
    // Reset first: dropping a started controller calls InCallManager.stop(),
    // which must not count towards this test.
    resetAudioRouteControllerForTesting();
    jest.clearAllMocks();
    jest.useFakeTimers();
    callkeep.__reset();
    bridge = new CallKeepBridge();
    await bridge.setup({ appName: 'Demo' });
  });

  afterEach(() => {
    bridge.destroy();
    jest.useRealTimers();
  });

  it('answers the call immediately without waiting for the audio session', () => {
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient({ session: { incomingCalls$: incoming$ } } as never);
    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    const call = createCall('c1');
    incoming$.next([call]);

    callkeep.__emit('answerCall', { callUUID: uuid });

    // The SDK answer must not be gated — only audio start is.
    expect(call.answer).toHaveBeenCalled();
  });

  it('does not start audio before didActivateAudioSession fires', async () => {
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient({ session: { incomingCalls$: incoming$ } } as never);
    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    incoming$.next([createCall('c1')]);

    callkeep.__emit('answerCall', { callUUID: uuid });
    await Promise.resolve();

    // Starting media here is the classic "connects but is silent" bug.
    expect(InCallManager.start).not.toHaveBeenCalled();
  });

  it('starts audio once the audio session is activated', async () => {
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient({ session: { incomingCalls$: incoming$ } } as never);
    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    incoming$.next([createCall('c1')]);

    callkeep.__emit('answerCall', { callUUID: uuid });
    callkeep.__emit('didActivateAudioSession', {});
    await Promise.resolve();
    await Promise.resolve();

    expect(InCallManager.start).toHaveBeenCalledWith({ media: 'audio' });
  });

  it('starts audio anyway if the OS never activates the session', async () => {
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient({ session: { incomingCalls$: incoming$ } } as never);
    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    incoming$.next([createCall('c1')]);

    callkeep.__emit('answerCall', { callUUID: uuid });
    await jest.advanceTimersByTimeAsync(3100);

    // A permanently silent call is worse than a slightly early start.
    expect(InCallManager.start).toHaveBeenCalled();
  });

  it('shows a pushed call as video in CallKit once its video bridge call binds', async () => {
    // iOS shows every VoIP push as a voice call. The call placed for it is
    // the first thing that knows the media.
    bridge.destroy();
    resetAudioRouteControllerForTesting();
    bridge = new CallKeepBridge();
    await bridge.setup({ appName: 'Demo', supportsVideo: true });

    const uuid = bridge.reportIncomingPush({ callId: 'c1', from: '+15551234', fromName: 'Ada' });
    callkeep.__emit('answerCall', { callUUID: uuid });
    callkeep.__emit('didActivateAudioSession', {});
    await jest.advanceTimersByTimeAsync(0);
    expect(InCallManager.start).not.toHaveBeenCalled();

    const call = { ...createCall('bridge-v'), mediaDirections: { audio: 'sendrecv', video: 'sendrecv' } };
    expect(bridge.bindBridgeCall(uuid, call as never)).toBe(true);
    expect(RNCallKeep.updateDisplay).toHaveBeenCalledWith(uuid, 'Ada', '+15551234', {
      ios: { hasVideo: true }
    });

    call.status$.next('connected');
    await jest.advanceTimersByTimeAsync(3100);
    expect(InCallManager.start).toHaveBeenCalledWith({ media: 'video' });
  });

  it('starts audio when CallKit activates the session, and leaves no fallback timer behind', async () => {
    const call = createCall('out-1');
    bridge.trackCall(call as never, '/public/room', 'Support');
    call.status$.next('connected');
    await flush();
    expect(InCallManager.start).not.toHaveBeenCalled();

    callkeep.__emit('didActivateAudioSession', {});
    await flush();

    expect(InCallManager.start).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('still starts audio after the fallback timeout when the session never activates', async () => {
    const call = createCall('out-2');
    bridge.trackCall(call as never, '/public/room', 'Support');
    call.status$.next('connected');
    await flush();
    expect(InCallManager.start).not.toHaveBeenCalled();

    jest.advanceTimersByTime(3000);
    await flush();

    expect(InCallManager.start).toHaveBeenCalledTimes(1);
  });

  it('starts an outbound call at once when CallKit activated the session before it connected', async () => {
    // CallKit activates the session for an outbound call when the start-call
    // action is fulfilled, before the far end answers. A gate created at
    // `connected` used to wait for an activation that had already happened.
    const call = createCall('out-3');
    bridge.trackCall(call as never, '/public/room', 'Support');
    callkeep.__emit('didActivateAudioSession', {});
    call.status$.next('connected');
    await flush();

    expect(InCallManager.start).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('releases the answer-time and the connect-time wait with one activation', async () => {
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient({ session: { incomingCalls$: incoming$ } } as never);
    const call = createCall('in-1');
    incoming$.next([call]);
    const uuid = (RNCallKeep.displayIncomingCall as jest.Mock).mock.calls[0]?.[0] as string;

    callkeep.__emit('answerCall', { callUUID: uuid });
    call.status$.next('connected');
    await flush();
    expect(call.answer).toHaveBeenCalled();
    expect(InCallManager.start).not.toHaveBeenCalled();

    callkeep.__emit('didActivateAudioSession', {});
    await flush();

    expect(InCallManager.start).toHaveBeenCalledTimes(1);
    // Neither wait is left holding a fallback timer.
    expect(jest.getTimerCount()).toBe(0);
  });

  it('waits again once CallKit has deactivated the session', async () => {
    callkeep.__emit('didActivateAudioSession', {});
    callkeep.__emit('didDeactivateAudioSession', {});
    const call = createCall('out-4');
    bridge.trackCall(call as never, '/public/room', 'Support');
    call.status$.next('connected');
    await flush();
    expect(InCallManager.start).not.toHaveBeenCalled();

    callkeep.__emit('didActivateAudioSession', {});
    await flush();
    expect(InCallManager.start).toHaveBeenCalledTimes(1);
  });

  it('counts an activation callkeep replayed from before JavaScript started', async () => {
    callkeep.__emit('didLoadWithEvents', [{ name: 'RNCallKeepDidActivateAudioSession', data: null }]);
    const call = createCall('out-5');
    bridge.trackCall(call as never, '/public/room', 'Support');
    call.status$.next('connected');
    await flush();

    expect(InCallManager.start).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not start audio for a call that ended while it waited for the session', async () => {
    // Started anyway, the session would stay up with nothing to stop it, and
    // because start() is first-wins the next call would inherit its mode.
    const call = createCall('out-6');
    bridge.trackCall(call as never, '/public/room', 'Support');
    call.status$.next('connected');
    await flush();
    call.status$.next('ended');
    await flush();

    callkeep.__emit('didActivateAudioSession', {});
    await flush();
    expect(InCallManager.start).not.toHaveBeenCalled();

    // Nor when the fallback fires instead.
    const late = createCall('out-7');
    bridge.trackCall(late as never, '/public/room', 'Support');
    callkeep.__emit('didDeactivateAudioSession', {});
    late.status$.next('connected');
    await flush();
    late.status$.next('ended');
    await jest.advanceTimersByTimeAsync(3100);
    expect(InCallManager.start).not.toHaveBeenCalled();
  });

  it('starts audio for an answered push once its call connects, on the session already up', async () => {
    // A pending push entry is live: the liveness check must not drop it. Its
    // audio waits for its call, which knows the media.
    const uuid = bridge.reportIncomingPush({ callId: 'c-later' });
    callkeep.__emit('answerCall', { callUUID: uuid });
    callkeep.__emit('didActivateAudioSession', {});
    await flush();
    expect(InCallManager.start).not.toHaveBeenCalled();

    const call = createCall('bridge-later');
    expect(bridge.bindBridgeCall(uuid, call as never)).toBe(true);
    call.status$.next('connected');
    await flush();

    expect(InCallManager.start).toHaveBeenCalledTimes(1);
  });

  it("leaves a SIP or Fabric caller's generic handle alone when its video bridge call binds", async () => {
    // callkeep's updateDisplay always rebuilds the remote handle as
    // CXHandleTypePhoneNumber, so a `sip:` or Fabric address reported as
    // generic would become a 'phone number' in CallKit and Recents.
    bridge.destroy();
    resetAudioRouteControllerForTesting();
    bridge = new CallKeepBridge();
    await bridge.setup({ appName: 'Demo', supportsVideo: true });

    for (const from of ['sip:alice@example.com', '/private/alice']) {
      const uuid = bridge.reportIncomingPush({ callId: `c-${from}`, from, fromName: 'Alice' });
      callkeep.__emit('answerCall', { callUUID: uuid });
      const call = { ...createCall(`bridge-${from}`), mediaDirections: { audio: 'sendrecv', video: 'sendrecv' } };
      expect(bridge.bindBridgeCall(uuid, call as never)).toBe(true);
    }

    expect(RNCallKeep.updateDisplay).not.toHaveBeenCalled();
  });

  it('leaves the CallKit type alone when a voice bridge call binds', async () => {
    const uuid = bridge.reportIncomingPush({ callId: 'c2' });
    callkeep.__emit('answerCall', { callUUID: uuid });

    bridge.bindBridgeCall(uuid, { ...createCall('bridge-a'), mediaDirections: { audio: 'sendrecv', video: 'inactive' } } as never);

    expect(RNCallKeep.updateDisplay).not.toHaveBeenCalled();
  });

  it('stops the audio session when the call ends', async () => {
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient({ session: { incomingCalls$: incoming$ } } as never);
    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    incoming$.next([createCall('c1')]);
    callkeep.__emit('answerCall', { callUUID: uuid });
    callkeep.__emit('didActivateAudioSession', {});
    await jest.advanceTimersByTimeAsync(0);
    expect(InCallManager.start).toHaveBeenCalledTimes(1);

    callkeep.__emit('endCall', { callUUID: uuid });

    expect(InCallManager.stop).toHaveBeenCalledTimes(1);
  });

  it('starts no audio for a push the user answered and ended before the session came up', async () => {
    // The entry stays 'pending-push' with a buffered reject, which the
    // liveness check has to read as over.
    const uuid = bridge.reportIncomingPush({ callId: 'p1', data: { bridgeToken: 't' } });
    callkeep.__emit('answerCall', { callUUID: uuid });
    callkeep.__emit('endCall', { callUUID: uuid });

    await jest.advanceTimersByTimeAsync(3100);

    expect(InCallManager.start).not.toHaveBeenCalled();
  });

  it('starts no audio for a cold start whose replay ends the call it answered', async () => {
    callkeep.__emit('didLoadWithEvents', [
      {
        name: 'RNCallKeepDidDisplayIncomingCall',
        data: {
          callUUID: 'cold-1',
          handle: '+1555',
          localizedCallerName: 'Ada',
          fromPushKit: '1',
          payload: { callId: 'c-cold', bridgeToken: 't' }
        }
      },
      { name: 'RNCallKeepPerformAnswerCallAction', data: { callUUID: 'cold-1' } },
      { name: 'RNCallKeepDidActivateAudioSession', data: null },
      { name: 'RNCallKeepPerformEndCallAction', data: { callUUID: 'cold-1' } }
    ]);

    await jest.advanceTimersByTimeAsync(3100);

    expect(InCallManager.start).not.toHaveBeenCalled();
  });

  it("waits for the next call's activation once a call's audio is stopped", async () => {
    // incall-manager's stop() deactivates the session itself, so a standing
    // activation from the call that ended says nothing about the next one.
    const a = createCall('out-a');
    bridge.trackCall(a as never, '/public/room', 'Support');
    callkeep.__emit('didActivateAudioSession', {});
    a.status$.next('connected');
    await flush();
    expect(InCallManager.start).toHaveBeenCalledTimes(1);
    a.status$.next('destroyed');
    expect(InCallManager.stop).toHaveBeenCalledTimes(1);

    const b = createCall('out-b');
    bridge.trackCall(b as never, '/public/room', 'Support');
    b.status$.next('connected');
    await flush();
    expect(InCallManager.start).toHaveBeenCalledTimes(1);

    callkeep.__emit('didActivateAudioSession', {});
    await flush();
    expect(InCallManager.start).toHaveBeenCalledTimes(2);
  });

  it('waits for an activation again after CallKit resets its provider', async () => {
    callkeep.__emit('didActivateAudioSession', {});
    callkeep.__emit('didResetProvider', {});
    const call = createCall('out-r');
    bridge.trackCall(call as never, '/public/room', 'Support');
    call.status$.next('connected');
    await flush();

    expect(InCallManager.start).not.toHaveBeenCalled();
  });
});

describe('CallKeepBridge on iOS — a CallKit provider reset', () => {
  let bridge: CallKeepBridge;

  beforeEach(async () => {
    resetAudioRouteControllerForTesting();
    jest.clearAllMocks();
    jest.useFakeTimers();
    callkeep.__reset();
    bridge = new CallKeepBridge();
    await bridge.setup({ appName: 'Demo' });
  });

  afterEach(() => {
    bridge.destroy();
    jest.useRealTimers();
  });

  it('ends every live call, hangs up its SDK call and stops the audio session', async () => {
    // CallKit drops its calls on a reset and sends no endCall for them.
    const a = createCall('out-a');
    const uuidA = bridge.trackCall(a as never, '/public/room', 'Support');
    callkeep.__emit('didActivateAudioSession', {});
    a.status$.next('connected');
    await flush();
    expect(InCallManager.start).toHaveBeenCalledTimes(1);

    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient({ session: { incomingCalls$: incoming$ } } as never);
    const b = createCall('in-b');
    incoming$.next([b]);
    const uuidB = bridge.registry.uuidForCall(b as never)!;

    callkeep.__emit('didResetProvider', {});

    expect(a.hangup).toHaveBeenCalledTimes(1);
    expect(b.hangup).toHaveBeenCalledTimes(1);
    expect(bridge.registry.entryForUuid(uuidA)?.state).toBe('ended');
    expect(bridge.registry.entryForUuid(uuidB)?.state).toBe('ended');
    expect(InCallManager.stop).toHaveBeenCalledTimes(1);
  });

  it('ends a ringing push, so no audio starts for it', async () => {
    const uuid = bridge.reportIncomingPush({ callId: 'p1' });
    callkeep.__emit('answerCall', { callUUID: uuid });

    callkeep.__emit('didResetProvider', {});
    await jest.advanceTimersByTimeAsync(3100);

    expect(bridge.registry.entryForUuid(uuid)?.intent).toBe('reject');
    expect(InCallManager.start).not.toHaveBeenCalled();
  });

  it("starts the next call's audio afresh", async () => {
    const a = createCall('out-a');
    bridge.trackCall(a as never, '/public/room', 'Support');
    callkeep.__emit('didActivateAudioSession', {});
    a.status$.next('connected');
    await flush();

    callkeep.__emit('didResetProvider', {});

    const b = createCall('out-b');
    bridge.trackCall(b as never, '/public/room', 'Support');
    b.status$.next('connected');
    callkeep.__emit('didActivateAudioSession', {});
    await flush();

    expect(InCallManager.start).toHaveBeenCalledTimes(2);
  });
});

describe('CallKeepBridge — the fusion tick timer', () => {
  let bridge: CallKeepBridge;

  beforeEach(async () => {
    // Reset first: dropping a started controller calls InCallManager.stop(),
    // which must not count towards this test.
    resetAudioRouteControllerForTesting();
    jest.clearAllMocks();
    jest.useFakeTimers();
    callkeep.__reset();
    bridge = new CallKeepBridge({ fusionTimeoutMs: 5000 });
    await bridge.setup({ appName: 'Demo' });
  });

  afterEach(() => {
    bridge.destroy();
    jest.useRealTimers();
  });

  it('ends an unfused push as missed once the deadline passes', () => {
    const uuid = bridge.reportIncomingPush({ callId: 'never-arrives' });

    jest.advanceTimersByTime(6000);

    // A stuck CallKit entry is the failure mode iOS punishes hardest.
    expect(RNCallKeep.reportEndCallWithUUID).toHaveBeenCalledWith(uuid, expect.any(Number));
    expect(bridge.registry.entryForUuid(uuid)?.state).toBe('ended');
  });

  it('leaves the entry alone before the deadline', () => {
    bridge.reportIncomingPush({ callId: 'c1' });
    jest.advanceTimersByTime(4000);
    expect(RNCallKeep.reportEndCallWithUUID).not.toHaveBeenCalled();
  });

  it('stops ticking once no entry is pending, leaving no idle timer', () => {
    bridge.reportIncomingPush({ callId: 'c1' });
    jest.advanceTimersByTime(6000);

    const timersAfterExpiry = jest.getTimerCount();
    jest.advanceTimersByTime(30_000);

    expect(timersAfterExpiry).toBe(0);
  });

  it('does not expire a push that fused in time', () => {
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient({ session: { incomingCalls$: incoming$ } } as never);
    const uuid = bridge.reportIncomingPush({ callId: 'c1' });

    jest.advanceTimersByTime(2000);
    incoming$.next([createCall('c1')]);
    jest.advanceTimersByTime(30_000);

    expect(RNCallKeep.reportEndCallWithUUID).not.toHaveBeenCalled();
    expect(bridge.registry.entryForUuid(uuid)?.state).toBe('fused');
  });

  it('adopts a bridge dial into the answered entry instead of a second call', () => {
    // CallKit rejects a startCall transaction while an answered call is live:
    // "Error requesting transaction". The dial then dies and the entry is torn
    // down as missed, with nothing in the logs naming the cause.
    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    (RNCallKeep.startCall as jest.Mock).mockClear();

    bridge.beginBridgeDial(uuid);
    const tracked = bridge.trackCall(createCall('bridge-call') as never, 'bridge', 'bridge');

    expect(tracked).toBe(uuid);
    expect(RNCallKeep.startCall).not.toHaveBeenCalled();
  });

  it('releases the claim, so the next ordinary dial is not swallowed', () => {
    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    bridge.beginBridgeDial(uuid);
    bridge.endBridgeDial();
    (RNCallKeep.startCall as jest.Mock).mockClear();

    bridge.trackCall(createCall('normal-call') as never, '+15559998888', 'Someone');

    expect(RNCallKeep.startCall).toHaveBeenCalled();
  });

  it('still reports an outbound call when the entry died mid-dial', () => {
    // Otherwise the user is on a live call with no native UI to end it.
    bridge.beginBridgeDial('never-existed');
    (RNCallKeep.startCall as jest.Mock).mockClear();

    bridge.trackCall(createCall('orphan') as never, 'bridge', 'bridge');

    expect(RNCallKeep.startCall).toHaveBeenCalled();
  });

  it('ends the native entry when the SDK reports the call ended', () => {
    // The SDK emits 'ended'; the old terminal set listed only 'disconnected',
    // 'destroyed' and 'failed', so a remote hangup left the entry on screen
    // and the user had to hang up manually.
    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    const call = createCall('c1');
    bridge.beginBridgeDial(uuid);
    bridge.trackCall(call as never, 'bridge', 'bridge');
    (RNCallKeep.reportEndCallWithUUID as jest.Mock).mockClear();

    (call.status$ as { next: (v: string) => void }).next('ended');

    expect(RNCallKeep.reportEndCallWithUUID).toHaveBeenCalled();
  });

  it('replays a cold-start answer that fired before JavaScript existed', () => {
    // The normal case for an incoming call: the push launches a killed app,
    // the user answers from the lock screen, and both happen before React
    // mounts. callkeep buffers those into didLoadWithEvents; without handling
    // it the answer reaches nobody, nothing dials the bridge, and the caller
    // waits on a parked leg until it times out.
    const answered: string[] = [];
    bridge.registry.answerRequested$.subscribe((entry) => answered.push(entry.uuid));

    callkeep.__emit('didLoadWithEvents', [
      {
        name: 'RNCallKeepDidDisplayIncomingCall',
        data: {
          callUUID: 'cold-uuid',
          handle: '+15551234567',
          localizedCallerName: 'Ada',
          fromPushKit: '1',
          payload: { callId: 'c-cold', bridgeToken: 'tok-1' }
        }
      },
      { name: 'RNCallKeepPerformAnswerCallAction', data: { callUUID: 'cold-uuid' } }
    ]);

    expect(answered).toContain('cold-uuid');
  });

  it('carries the bridge token through the replayed display event', () => {
    // Without the token the answer cannot dial anything, so replaying the
    // answer alone would still strand the caller.
    let seen: Record<string, string> | undefined;
    bridge.registry.answerRequested$.subscribe((entry) => {
      seen = entry.data;
    });

    callkeep.__emit('didLoadWithEvents', [
      {
        name: 'RNCallKeepDidDisplayIncomingCall',
        data: {
          callUUID: 'cold-uuid-2',
          handle: '+15551234567',
          localizedCallerName: 'Ada',
          fromPushKit: '1',
          payload: { callId: 'c-cold-2', bridgeToken: 'tok-2' }
        }
      },
      { name: 'RNCallKeepPerformAnswerCallAction', data: { callUUID: 'cold-uuid-2' } }
    ]);

    expect(seen?.bridgeToken).toBe('tok-2');
  });

  it('ignores an empty replay, which is the warm-start case', () => {
    expect(() => callkeep.__emit('didLoadWithEvents', [])).not.toThrow();
  });

  it("clears callkeep's launch buffer once it is replayed", () => {
    // callkeep keeps the buffer for the life of the process and sends it again
    // on every startObserving (a JS reload, say): replayed again, an old
    // answer would start audio for a dead call, and an old activation would
    // claim a session that is gone.
    callkeep.__emit('didLoadWithEvents', [
      { name: 'RNCallKeepPerformAnswerCallAction', data: { callUUID: 'old-uuid' } },
      { name: 'RNCallKeepDidActivateAudioSession', data: null }
    ]);

    expect(RNCallKeep.clearInitialEvents).toHaveBeenCalledTimes(1);
  });

  it('applies a replayed answer to the launch push adopted after the replay', async () => {
    // Under the new architecture callkeep is created lazily, after the
    // PushKit display went out, so the replay can carry the answer without
    // its display, and it reaches JS before setup() adopts the cached push.
    nativeModules.SignalWireVoipPush = {
      getToken: async () => 'tok',
      getPendingCall: async () => ({
        uuid: 'launch-2',
        callId: 'c-launch-2',
        handle: '+15551234567',
        callerName: 'Ada',
        bridgeToken: 'bt-2'
      }),
      clearPendingCall: async () => undefined
    };
    const fresh = new CallKeepBridge();
    const answered: string[] = [];
    fresh.registry.answerRequested$.subscribe((entry) => answered.push(entry.uuid));

    callkeep.__emit('didLoadWithEvents', [
      { name: 'RNCallKeepPerformAnswerCallAction', data: { callUUID: 'launch-2' } }
    ]);
    await fresh.setup({ appName: 'Demo' });

    expect(answered).toEqual(['launch-2']);
    expect(fresh.registry.entryForUuid('launch-2')?.intent).toBe('answer');
    fresh.destroy();
    delete nativeModules.SignalWireVoipPush;
  });

  it('holds a live answer that arrives before setup() has adopted the launch push', async () => {
    // setup() registers its listeners, then waits for the cached push; an
    // answer delivered in that wait found no entry and was lost, and the entry
    // was adopted with no intent: answered on screen, nothing dialled.
    nativeModules.SignalWireVoipPush = {
      getToken: async () => 'tok',
      getPendingCall: async () => {
        callkeep.__emit('answerCall', { callUUID: 'launch-3' });
        return { uuid: 'launch-3', callId: 'c-launch-3', handle: '+15551234567', callerName: 'Ada' };
      },
      clearPendingCall: async () => undefined
    };
    const fresh = new CallKeepBridge();
    const answered: string[] = [];
    fresh.registry.answerRequested$.subscribe((entry) => answered.push(entry.uuid));

    await fresh.setup({ appName: 'Demo' });

    expect(answered).toEqual(['launch-3']);
    expect(fresh.registry.entryForUuid('launch-3')?.intent).toBe('answer');
    fresh.destroy();
    delete nativeModules.SignalWireVoipPush;
  });

  it('ends the native call of a held answer whose push is never adopted', async () => {
    // Two pushes before JavaScript runs: the cache keeps only the last, so the
    // first one's replayed answer waited for an adoption that never came, with
    // no entry, no tick and CallKit showing a call answered with nobody on it.
    callkeep.__emit('didLoadWithEvents', [
      { name: 'RNCallKeepPerformAnswerCallAction', data: { callUUID: 'never-adopted' } }
    ]);

    jest.advanceTimersByTime(4000);
    expect(RNCallKeep.reportEndCallWithUUID).not.toHaveBeenCalled();
    jest.advanceTimersByTime(2100);

    expect(RNCallKeep.reportEndCallWithUUID).toHaveBeenCalledWith('never-adopted', 6);
    expect(jest.getTimerCount()).toBe(0);
    // Expired, the hold no longer applies to a late display of that uuid.
    callkeep.__emit('didDisplayIncomingCall', {
      callUUID: 'never-adopted',
      handle: '+15551234567',
      localizedCallerName: 'Ada',
      fromPushKit: '1'
    });
    expect(bridge.registry.entryForUuid('never-adopted')?.intent).toBeNull();
  });

  it('drops a held end whose push is never adopted, without a second native end', () => {
    callkeep.__emit('didLoadWithEvents', [
      { name: 'RNCallKeepPerformAnswerCallAction', data: { callUUID: 'ended-early' } },
      { name: 'RNCallKeepPerformEndCallAction', data: { callUUID: 'ended-early' } }
    ]);

    jest.advanceTimersByTime(6100);

    expect(RNCallKeep.reportEndCallWithUUID).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('adopts the launch push, which is the only record of a cold-start call', async () => {
    // On a cold start CallKit is already showing the call before any
    // JavaScript runs. callkeep's didDisplayIncomingCall went to listeners
    // that did not exist, and its didLoadWithEvents replay does not fire on
    // iOS here, so without adopting the cached push the registry has no
    // entry and the user's answer is applied to nothing.
    nativeModules.SignalWireVoipPush = {
      getToken: async () => 'tok',
      getPendingCall: async () => ({
        uuid: 'launch-uuid',
        callId: 'c-launch',
        handle: '+15551234567',
        callerName: 'Ada',
        bridgeToken: 'bt-1'
      }),
      clearPendingCall: async () => undefined
    };

    const fresh = new CallKeepBridge();
    await fresh.setup({ appName: 'Demo' });

    const entry = fresh.registry.entryForUuid('launch-uuid');
    expect(entry).toBeDefined();
    expect(entry?.data?.bridgeToken).toBe('bt-1');
    delete nativeModules.SignalWireVoipPush;
  });

  it('does not adopt anything when the app was not woken by a push', async () => {
    nativeModules.SignalWireVoipPush = {
      getToken: async () => 'tok',
      getPendingCall: async () => null,
      clearPendingCall: async () => undefined
    };

    const fresh = new CallKeepBridge();
    await fresh.setup({ appName: 'Demo' });

    expect(fresh.registry.entries).toHaveLength(0);
    delete nativeModules.SignalWireVoipPush;
  });
});

describe('CallKeepBridge on iOS — the audio session belongs to the call that started it', () => {
  let bridge: CallKeepBridge;
  let incoming$: Subject<unknown[]>;
  const start = InCallManager.start as jest.Mock;
  const stop = InCallManager.stop as jest.Mock;

  beforeEach(async () => {
    resetAudioRouteControllerForTesting();
    jest.clearAllMocks();
    jest.useFakeTimers();
    callkeep.__reset();
    bridge = new CallKeepBridge();
    await bridge.setup({ appName: 'Demo' });
    incoming$ = new Subject<unknown[]>();
    bridge.bindClient({ session: { incomingCalls$: incoming$ } } as never);
  });

  afterEach(() => {
    bridge.destroy();
    jest.useRealTimers();
  });

  /** An outbound call A, connected, with its audio running. */
  async function liveOutboundCall() {
    const call = createCall('A');
    const uuid = bridge.trackCall(call as never, '/public/agent', 'Agent');
    call.status$.next('connected');
    callkeep.__emit('didActivateAudioSession', {});
    await jest.advanceTimersByTimeAsync(3100);
    expect(start).toHaveBeenCalledTimes(1);
    return { call, uuid };
  }

  /** The uuid CallKit was last asked to show as incoming. */
  function lastDisplayedUuid(): string {
    const calls = (RNCallKeep.displayIncomingCall as jest.Mock).mock.calls;
    return calls[calls.length - 1]?.[0] as string;
  }

  it('keeps the live call’s audio when a waiting call’s caller gives up', async () => {
    await liveOutboundCall();
    const waiting = createCall('B');
    incoming$.next([waiting]);

    waiting.status$.next('destroyed');

    expect(stop).not.toHaveBeenCalled();
  });

  it('keeps the live call’s audio when the user declines a waiting call', async () => {
    await liveOutboundCall();
    incoming$.next([createCall('B')]);

    callkeep.__emit('endCall', { callUUID: lastDisplayedUuid() });

    expect(stop).not.toHaveBeenCalled();
  });

  it('hands the session to the call accepted with End & Accept instead of deactivating it', async () => {
    // CallKit sends A's end before B's answer, while it is handing the
    // session from A to B. Stopping incall-manager there runs setActive:NO
    // on the session CallKit is giving B.
    const a = await liveOutboundCall();
    const b = createCall('B');
    incoming$.next([b]);
    const bUuid = lastDisplayedUuid();

    callkeep.__emit('endCall', { callUUID: a.uuid });
    expect(stop).not.toHaveBeenCalled();

    callkeep.__emit('answerCall', { callUUID: bUuid });
    callkeep.__emit('didActivateAudioSession', {});
    await jest.advanceTimersByTimeAsync(3100);
    // B runs on the session A started; nothing was stopped or restarted.
    expect(stop).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);

    // A's hangup completes asynchronously; its 'destroyed' arrives after B's audio is up.
    a.call.status$.next('destroyed');
    expect(stop).not.toHaveBeenCalled();

    // B owns the session now: its end stops it.
    b.status$.next('destroyed');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('stops the handed-over session when the waiting call is declined instead', async () => {
    const a = await liveOutboundCall();
    incoming$.next([createCall('B')]);
    const bUuid = lastDisplayedUuid();

    a.call.status$.next('destroyed');
    expect(stop).not.toHaveBeenCalled();

    callkeep.__emit('endCall', { callUUID: bUuid });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('stops the session when its owner ends and the other call only rings', async () => {
    // A's far end hangs up while B is still ringing. B is not taking the
    // session, so A's (keep-screen-on, proximity, route) goes once the
    // End & Accept window has passed, and B gets a session of its own when
    // the user answers it.
    const a = await liveOutboundCall();
    const b = createCall('B');
    incoming$.next([b]);
    const bUuid = lastDisplayedUuid();

    a.call.status$.next('destroyed');
    await jest.advanceTimersByTimeAsync(1100);
    expect(stop).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(10_000);
    callkeep.__emit('answerCall', { callUUID: bUuid });
    callkeep.__emit('didActivateAudioSession', {});
    await jest.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('gives the accepted call a session of its own when the ended one was started for other media', async () => {
    // incall-manager's media fixes the mode (VoiceChat or VideoChat), the
    // proximity sensor and the default route; B handed A's session as it is
    // would run in A's mode (a voice call on the loudspeaker after a video
    // call). Restarted after B's own activation, not between A's end and B's
    // answer, where stopping deactivates the session CallKit is handing over.
    bridge.destroy();
    resetAudioRouteControllerForTesting();
    bridge = new CallKeepBridge();
    await bridge.setup({ appName: 'Demo', supportsVideo: true });
    incoming$ = new Subject<unknown[]>();
    bridge.bindClient({ session: { incomingCalls$: incoming$ } } as never);

    // A: an outbound video call, connected, its session started for video.
    const a = { ...createCall('A'), mediaDirections: { audio: 'sendrecv', video: 'sendrecv' } };
    const aUuid = bridge.trackCall(a as never, '/public/agent', 'Agent');
    a.status$.next('connected');
    callkeep.__emit('didActivateAudioSession', {});
    await jest.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenLastCalledWith({ media: 'video' });

    // B: an inbound SDK call, which the registry answers as voice.
    const b = createCall('B');
    incoming$.next([b]);
    const bUuid = lastDisplayedUuid();

    callkeep.__emit('endCall', { callUUID: aUuid });
    callkeep.__emit('answerCall', { callUUID: bUuid });
    expect(stop).not.toHaveBeenCalled();
    callkeep.__emit('didActivateAudioSession', {});
    await jest.advanceTimersByTimeAsync(0);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenLastCalledWith({ media: 'audio' });
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[1]!);
  });

  it('stops the session at once when the ending call is the only one', async () => {
    const a = await liveOutboundCall();

    callkeep.__emit('endCall', { callUUID: a.uuid });

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('starts no audio for a push the user answered and ended before the session came up', async () => {
    const uuid = bridge.reportIncomingPush({ callId: 'p1', data: { bridgeToken: 't' } });
    callkeep.__emit('answerCall', { callUUID: uuid });
    callkeep.__emit('endCall', { callUUID: uuid });

    await jest.advanceTimersByTimeAsync(3100);

    expect(start).not.toHaveBeenCalled();
  });

  it('leaves no audio running for a push the user ends before its call exists', async () => {
    // Combined with #3: a push's audio starts only when its call connects, so
    // there is nothing to stop here, and nothing left behind.
    const uuid = bridge.reportIncomingPush({ callId: 'p1', data: { bridgeToken: 't' } });
    callkeep.__emit('answerCall', { callUUID: uuid });
    callkeep.__emit('didActivateAudioSession', {});
    await jest.advanceTimersByTimeAsync(0);

    callkeep.__emit('endCall', { callUUID: uuid });
    await jest.advanceTimersByTimeAsync(3100);

    // Still 'pending-push' with a buffered reject, but the call is over.
    expect(bridge.registry.entryForUuid(uuid)?.intent).toBe('reject');
    expect(start).not.toHaveBeenCalled();
  });

  it('starts no audio for a cold start whose replay ends the call it answered', async () => {
    callkeep.__emit('didLoadWithEvents', [
      {
        name: 'RNCallKeepDidDisplayIncomingCall',
        data: {
          callUUID: 'cold-1',
          handle: '+1555',
          localizedCallerName: 'Ada',
          fromPushKit: '1',
          payload: { callId: 'c-cold', bridgeToken: 't' }
        }
      },
      { name: 'RNCallKeepPerformAnswerCallAction', data: { callUUID: 'cold-1' } },
      { name: 'RNCallKeepPerformEndCallAction', data: { callUUID: 'cold-1' } }
    ]);

    await jest.advanceTimersByTimeAsync(3100);

    expect(start).not.toHaveBeenCalled();
  });

  it('does not bridge a push the user ended while its call was being placed', async () => {
    const uuid = bridge.reportIncomingPush({ callId: 'p3', data: { bridgeToken: 't' } });
    callkeep.__emit('answerCall', { callUUID: uuid });
    callkeep.__emit('endCall', { callUUID: uuid });

    // useBridgeAnswer: claim, dial (the observer's trackCall), release, bind.
    bridge.beginBridgeDial(uuid);
    const call = createCall('bridge-p3');
    bridge.trackCall(call as never, '/private/bridge', 'Ada');
    bridge.endBridgeDial();

    expect(bridge.bindBridgeCall(uuid, call as never)).toBe(false);
    // No second CallKit call for it, and it is hung up rather than left live.
    expect(RNCallKeep.startCall).not.toHaveBeenCalled();
    expect(call.hangup).toHaveBeenCalled();
  });

  it('stops the audio when the app ends an answered push through the registry', async () => {
    // The example does this when its bridge dial fails. reportEndCallWithUUID
    // gets no endCall action back from CallKit, so the bridge has to notice.
    const uuid = bridge.reportIncomingPush({ callId: 'p5', data: { bridgeToken: 't' } });
    callkeep.__emit('answerCall', { callUUID: uuid });
    callkeep.__emit('didActivateAudioSession', {});
    const bridgeCall = createCall('bridge-p5');
    bridge.bindBridgeCall(uuid, bridgeCall as never);
    bridgeCall.status$.next('connected');
    await jest.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenCalledTimes(1);

    bridge.registry.endCall(uuid);

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('leaves no audio running when an answered push expires without its call', async () => {
    const uuid = bridge.reportIncomingPush({ callId: 'p6' });
    callkeep.__emit('answerCall', { callUUID: uuid });
    callkeep.__emit('didActivateAudioSession', {});
    await jest.advanceTimersByTimeAsync(62_000);

    expect(bridge.registry.entryForUuid(uuid)?.state).toBe('ended');
    expect(start).not.toHaveBeenCalled();
  });

  it('lets the next call start its own session after a registry-ended one', async () => {
    const uuid = bridge.reportIncomingPush({ callId: 'p7', data: { bridgeToken: 't' } });
    callkeep.__emit('answerCall', { callUUID: uuid });
    callkeep.__emit('didActivateAudioSession', {});
    const bridgeCall = createCall('bridge-p7');
    bridge.bindBridgeCall(uuid, bridgeCall as never);
    bridgeCall.status$.next('connected');
    await jest.advanceTimersByTimeAsync(0);
    bridge.registry.endCall(uuid);

    const next = createCall('next');
    bridge.trackCall(next as never, '/public/agent', 'Agent');
    next.status$.next('connected');
    callkeep.__emit('didActivateAudioSession', {});
    await jest.advanceTimersByTimeAsync(3100);

    expect(start).toHaveBeenCalledTimes(2);
  });

  it('releases the session it owns when the bridge is destroyed', async () => {
    await liveOutboundCall();

    bridge.destroy();

    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('CallKeepBridge on iOS — a provider reset and the session owner', () => {
  let bridge: CallKeepBridge;
  const start = InCallManager.start as jest.Mock;
  const stop = InCallManager.stop as jest.Mock;

  beforeEach(async () => {
    resetAudioRouteControllerForTesting();
    jest.clearAllMocks();
    jest.useFakeTimers();
    callkeep.__reset();
    bridge = new CallKeepBridge();
    await bridge.setup({ appName: 'Demo' });
  });

  afterEach(() => {
    bridge.destroy();
    jest.useRealTimers();
  });

  /** An outbound call that owns the session. */
  async function owningCall(id: string) {
    const call = createCall(id);
    const uuid = bridge.trackCall(call as never, '/public/room', 'Support');
    call.status$.next('connected');
    callkeep.__emit('didActivateAudioSession', {});
    await jest.advanceTimersByTimeAsync(3100);
    return { call, uuid };
  }

  it('releases the owner’s session at once, ending a push that is still ringing with it', async () => {
    // The ringing push is ended too, so it holds no handover open.
    const a = await owningCall('out-a');
    const ringing = bridge.reportIncomingPush({ callId: 'ringing' });

    callkeep.__emit('didResetProvider', {});

    expect(a.call.hangup).toHaveBeenCalledTimes(1);
    expect(bridge.registry.isLive(a.uuid)).toBe(false);
    expect(bridge.registry.entryForUuid(ringing)?.intent).toBe('reject');
    expect(bridge.registry.isLive(ringing)).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('gives the next call a session of its own, which its end stops', async () => {
    await owningCall('out-a');
    callkeep.__emit('didResetProvider', {});
    expect(stop).toHaveBeenCalledTimes(1);

    const next = await owningCall('out-b');
    expect(start).toHaveBeenCalledTimes(2);

    next.call.status$.next('destroyed');
    expect(stop).toHaveBeenCalledTimes(2);
  });
});

describe('CallKeepBridge — binding a bridge call twice', () => {
  let bridge: CallKeepBridge;

  beforeEach(async () => {
    resetAudioRouteControllerForTesting();
    jest.clearAllMocks();
    jest.useFakeTimers();
    callkeep.__reset();
    bridge = new CallKeepBridge();
    await bridge.setup({ appName: 'Demo' });
  });

  afterEach(() => {
    bridge.destroy();
    jest.useRealTimers();
  });

  it('watches the call once when the claim and the app both bind it', async () => {
    const uuid = bridge.reportIncomingPush({ callId: 'p1', data: { bridgeToken: 't' } });
    callkeep.__emit('answerCall', { callUUID: uuid });

    // useBridgeAnswer: claim, dial (the observer's trackCall binds it), release, bind.
    bridge.beginBridgeDial(uuid);
    const call = createCall('bridge-1');
    expect(bridge.trackCall(call as never, '/private/bridge', 'Ada')).toBe(uuid);
    bridge.endBridgeDial();
    expect(bridge.bindBridgeCall(uuid, call as never)).toBe(true);

    call.status$.next('connected');
    callkeep.__emit('didActivateAudioSession', {});
    await jest.advanceTimersByTimeAsync(3100);
    expect(RNCallKeep.reportConnectedOutgoingCallWithUUID).toHaveBeenCalledTimes(1);

    call.status$.next('destroyed');
    expect(RNCallKeep.reportEndCallWithUUID).toHaveBeenCalledTimes(1);
  });
});

describe('CallKeepBridge on iOS — route choices with no session', () => {
  let bridge: CallKeepBridge;
  const speaker = InCallManager.setForceSpeakerphoneOn as jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    callkeep.__reset();
    resetAudioRouteControllerForTesting();
    bridge = new CallKeepBridge();
    await bridge.setup({ appName: 'Demo' });
  });

  afterEach(() => {
    bridge.destroy();
    jest.useRealTimers();
  });

  it('writes the speaker at once for a call the bridge does not track, after setup', () => {
    // The provider's callKit is off: the call is in-app only and nothing
    // will start a session for it, so a held tap would never be applied.
    getAudioRouteController().setSpeakerOn(true);
    expect(speaker).toHaveBeenCalledWith(true);
    expect(getAudioRouteController().route).toBe('speaker');
  });

  it('holds a tap while a tracked call has not started its session', () => {
    bridge.trackCall(createCall('out-1') as never, '/public/room', 'Support');
    getAudioRouteController().setSpeakerOn(true);
    expect(speaker).not.toHaveBeenCalled();
    expect(getAudioRouteController().route).toBe('speaker');
  });

  it('forgets a held tap when the last call ends without a session, so the next call does not get it', async () => {
    // A push rings, the user taps the speaker, the push never gets its call.
    bridge.reportIncomingPush({ callId: 'never' });
    getAudioRouteController().setSpeakerOn(true);
    expect(getAudioRouteController().route).toBe('speaker');

    await jest.advanceTimersByTimeAsync(60_000);

    expect(getAudioRouteController().route).toBe('earpiece');
    const call = createCall('out-2');
    bridge.trackCall(call as never, '/public/room', 'Support');
    call.status$.next('connected');
    await jest.advanceTimersByTimeAsync(5_000);
    expect(InCallManager.start).toHaveBeenCalled();
    expect(speaker).not.toHaveBeenCalled();
  });
});
