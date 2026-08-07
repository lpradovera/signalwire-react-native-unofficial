/**
 * iOS-specific bridge behaviour: the audio-session gate and the fusion tick
 * timer. Both are safety-critical and neither is exercised by the main bridge
 * suite, which runs with `Platform.OS === 'android'`.
 */
import InCallManager from 'react-native-incall-manager';
import RNCallKeep from 'react-native-callkeep';
import { Subject } from 'rxjs';

import { resetAudioRouteControllerForTesting } from '../audio/AudioRouteController';
import { CallKeepBridge } from './CallKeepBridge';

const nativeModules: { SignalWireVoipPush?: Record<string, unknown> } = {};
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

describe('CallKeepBridge on iOS — the audio-session gate', () => {
  let bridge: CallKeepBridge;

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

  it('starts a video session when the bridge was set up for video', async () => {
    bridge.destroy();
    resetAudioRouteControllerForTesting();
    bridge = new CallKeepBridge();
    await bridge.setup({ appName: 'Demo', supportsVideo: true });

    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient({ session: { incomingCalls$: incoming$ } } as never);
    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    incoming$.next([createCall('c1')]);

    callkeep.__emit('answerCall', { callUUID: uuid });
    callkeep.__emit('didActivateAudioSession', {});
    await Promise.resolve();
    await Promise.resolve();

    expect(InCallManager.start).toHaveBeenCalledWith({ media: 'video' });
  });

  it('stops the audio session when the call ends', () => {
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient({ session: { incomingCalls$: incoming$ } } as never);
    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    incoming$.next([createCall('c1')]);

    callkeep.__emit('endCall', { callUUID: uuid });

    expect(InCallManager.stop).toHaveBeenCalled();
  });
});

describe('CallKeepBridge — the fusion tick timer', () => {
  let bridge: CallKeepBridge;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    callkeep.__reset();
    resetAudioRouteControllerForTesting();
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
