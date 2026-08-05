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

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

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
});
