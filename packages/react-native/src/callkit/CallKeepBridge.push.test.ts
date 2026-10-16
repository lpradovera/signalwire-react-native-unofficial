/**
 * The bridge's push handling on both platforms: UUID case, end reasons, the
 * fusion timeout from setup(), a decline with no SDK call, and bridge dials
 * whose entry ended or already has its call.
 */
import RNCallKeep from 'react-native-callkeep';
import { BehaviorSubject } from 'rxjs';

import { resetAudioRouteControllerForTesting } from '../audio/AudioRouteController';
import { CallKeepBridge } from './CallKeepBridge';

const mockPlatform = { OS: 'ios' };
// callkeep is linked (setup() checks for its native module, RNCallKeep).
const mockNativeModules: { SignalWireVoipPush?: Record<string, unknown>; RNCallKeep?: Record<string, unknown> } = {
  RNCallKeep: { setup: () => undefined }
};
// Getters: the factory runs during the imports above, before these consts exist.
jest.mock('react-native', () => ({
  get Platform() {
    return mockPlatform;
  },
  get NativeModules() {
    return mockNativeModules;
  }
}));

const callkeep = RNCallKeep as unknown as typeof RNCallKeep & {
  __emit: (event: string, payload: unknown) => void;
  __reset: () => void;
};

const UPPER = 'E621E1F8-C36C-495A-93FC-0C247A3E6E5F';
const LOWER = UPPER.toLowerCase();

function createCall(id: string) {
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
    self: { mute: jest.fn(async () => undefined), unmute: jest.fn(async () => undefined) }
  };
}

function displayFromPushKit(uuid: string, payload: Record<string, string>) {
  callkeep.__emit('didDisplayIncomingCall', {
    callUUID: uuid,
    handle: '+15551234567',
    localizedCallerName: 'Ada',
    fromPushKit: '1',
    payload
  });
}

describe.each(['ios', 'android'])('CallKeepBridge push handling on %s', (os) => {
  let bridge: CallKeepBridge;

  beforeEach(async () => {
    mockPlatform.OS = os;
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
    delete mockNativeModules.SignalWireVoipPush;
  });

  describe('end reasons, from callkeep’s own table for this platform', () => {
    // callkeep's END_CALL_REASONS differ per platform (MISSED is 2 on iOS,
    // which CallKit takes as remoteEnded, and 6 on Android; 3 is unanswered
    // on iOS and BUSY on Android), and its native sides map them differently.
    const expected =
      os === 'ios'
        ? { missed: 3, failed: 1, remote: 2, duplicate: 4 }
        : { missed: 6, failed: 1, remote: 2, duplicate: 4 };

    it('ends an unanswered push as missed', () => {
      const uuid = bridge.reportIncomingPush({ callId: 'never' });
      jest.advanceTimersByTime(48_000);
      expect(RNCallKeep.reportEndCallWithUUID).toHaveBeenCalledWith(uuid, expected.missed);
    });

    it('ends a call the app gave up on as failed, not ended by the other party', () => {
      const uuid = bridge.reportIncomingPush({ data: { bridgeToken: 't' } });
      callkeep.__emit('answerCall', { callUUID: uuid });

      bridge.registry.endCall(uuid, 'failed');

      expect(RNCallKeep.reportEndCallWithUUID).toHaveBeenCalledWith(uuid, expected.failed);
    });

    it('ends an answered push whose call never came as failed', () => {
      const uuid = bridge.reportIncomingPush({ data: { bridgeToken: 't' } });
      callkeep.__emit('answerCall', { callUUID: uuid });
      jest.advanceTimersByTime(64_000);
      expect(RNCallKeep.reportEndCallWithUUID).toHaveBeenCalledWith(uuid, expected.failed);
    });

    it('ends a remote hangup as remote', () => {
      const uuid = bridge.reportIncomingPush({ data: { bridgeToken: 't' } });
      const call = createCall('bridge');
      bridge.bindBridgeCall(uuid, call as never);
      call.status$.next('ended');
      expect(RNCallKeep.reportEndCallWithUUID).toHaveBeenCalledWith(uuid, expected.remote);
    });

    it('declines a push declined in the app through the native decline, at once', () => {
      // Android's in-app sheet. reportEndCallWithUUID has no "declined" (or
      // rejected) reason on either platform; rejectCall is the decline.
      const uuid = bridge.reportIncomingPush({ callId: 'c1' });

      bridge.registry.applyIntent(uuid, 'reject');

      expect(RNCallKeep.rejectCall).toHaveBeenCalledWith(uuid);
      expect(RNCallKeep.reportEndCallWithUUID).not.toHaveBeenCalled();
    });

    it('does not decline again a push the native UI declined', () => {
      const uuid = bridge.reportIncomingPush({ callId: 'c1' });

      callkeep.__emit('endCall', { callUUID: uuid });
      // callkeep echoes the decline the app requested back as an endCall.
      callkeep.__emit('endCall', { callUUID: uuid });
      jest.advanceTimersByTime(48_000);

      expect(RNCallKeep.rejectCall).not.toHaveBeenCalled();
      expect(RNCallKeep.reportEndCallWithUUID).not.toHaveBeenCalled();
    });

    it('ends a native display of a call already shown as a duplicate', () => {
      const incoming$ = new BehaviorSubject<unknown[]>([createCall('c1')]);
      bridge.bindClient({ session: { incomingCalls$: incoming$ } } as never);

      displayFromPushKit(UPPER, { callId: 'c1' });

      expect(RNCallKeep.reportEndCallWithUUID).toHaveBeenCalledWith(LOWER, expected.duplicate);
    });
  });

  it('honours the fusionTimeoutMs given to setup()', async () => {
    // getCallKit() constructs the bridge with no options, so setup() is the
    // only place an app can pass it.
    const fresh = new CallKeepBridge();
    await fresh.setup({ appName: 'Demo', fusionTimeoutMs: 5000 });
    const uuid = fresh.reportIncomingPush({ callId: 'c1' });

    jest.advanceTimersByTime(8000);

    expect(fresh.registry.entryForUuid(uuid)?.state).toBe('ended');
    fresh.destroy();
  });

  it('asks the app to turn down a parked caller when the user declines in the native UI', () => {
    const declined: Array<Record<string, string> | undefined> = [];
    bridge.registry.rejectRequested$.subscribe((entry) => declined.push(entry.data));
    const uuid = bridge.reportIncomingPush({ data: { bridgeToken: 'tok' } });

    callkeep.__emit('endCall', { callUUID: uuid });

    expect(declined).toEqual([{ bridgeToken: 'tok' }]);
  });

  describe('a bridge dial whose entry cannot take it', () => {
    it('hangs up, with no second native call, when the entry ended during the dial', () => {
      // The 60 s answered timeout, or the app's endCall, while the dial was
      // in flight: reported as a new outgoing call, it rang as
      // "Calling /public/bridge…" and was hung up straight away.
      const uuid = bridge.reportIncomingPush({ data: { bridgeToken: 't' } });
      callkeep.__emit('answerCall', { callUUID: uuid });
      bridge.beginBridgeDial(uuid);
      bridge.registry.endCall(uuid);
      (RNCallKeep.startCall as jest.Mock).mockClear();
      const call = createCall('late-bridge');

      const tracked = bridge.trackCall(call as never, '/public/bridge', '/public/bridge');

      expect(tracked).toBe(uuid);
      expect(RNCallKeep.startCall).not.toHaveBeenCalled();
      expect(call.hangup).toHaveBeenCalled();
    });

    it('hangs up a second dial for an entry that already has its call', () => {
      const uuid = bridge.reportIncomingPush({ data: { bridgeToken: 't' } });
      callkeep.__emit('answerCall', { callUUID: uuid });
      const first = createCall('bridge-a');
      bridge.beginBridgeDial(uuid);
      bridge.trackCall(first as never, 'bridge', 'bridge');
      (RNCallKeep.startCall as jest.Mock).mockClear();
      const second = createCall('bridge-b');

      bridge.beginBridgeDial(uuid);
      bridge.trackCall(second as never, 'bridge', 'bridge');

      expect(RNCallKeep.startCall).not.toHaveBeenCalled();
      expect(second.hangup).toHaveBeenCalled();
      expect(first.hangup).not.toHaveBeenCalled();
      expect(bridge.registry.entryForUuid(uuid)?.call).toBe(first);
      expect(bridge.bindBridgeCall(uuid, second as never)).toBe(false);
    });
  });
});

describe('CallKeepBridge on iOS — callkeep lower-cases every action UUID', () => {
  let bridge: CallKeepBridge;

  beforeEach(async () => {
    mockPlatform.OS = 'ios';
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
    delete mockNativeModules.SignalWireVoipPush;
  });

  it('answers a PushKit call displayed with an upper-case UUID', () => {
    const asked: Array<Record<string, string> | undefined> = [];
    bridge.registry.answerRequested$.subscribe((entry) => asked.push(entry.data));
    displayFromPushKit(UPPER, { bridgeToken: 'tok' });

    callkeep.__emit('answerCall', { callUUID: LOWER });

    expect(asked).toEqual([{ bridgeToken: 'tok' }]);
  });

  it('answers the cached launch push when its UUID is upper-case', async () => {
    mockNativeModules.SignalWireVoipPush = {
      getToken: async () => 'tok',
      getPendingCall: async () => ({ uuid: UPPER, callId: 'c-launch', bridgeToken: 'bt' }),
      clearPendingCall: async () => undefined
    };
    const fresh = new CallKeepBridge();
    await fresh.setup({ appName: 'Demo' });
    const asked: string[] = [];
    fresh.registry.answerRequested$.subscribe((entry) => asked.push(entry.uuid));

    fresh.registry.applyIntent(LOWER, 'answer');

    expect(asked).toEqual([LOWER]);
    fresh.destroy();
  });

  it('routes hold, DTMF, mute and end to the call behind an upper-case UUID', async () => {
    const incoming$ = new BehaviorSubject<unknown[]>([]);
    bridge.bindClient({ session: { incomingCalls$: incoming$ } } as never);
    displayFromPushKit(UPPER, { callId: 'c1' });
    const call = createCall('c1');
    incoming$.next([call]);

    callkeep.__emit('didToggleHoldCallAction', { callUUID: LOWER, hold: true });
    callkeep.__emit('didPerformDTMFAction', { callUUID: LOWER, digits: '5' });
    callkeep.__emit('didPerformSetMutedCallAction', { callUUID: LOWER, muted: true });
    // Native holds are applied one after another, off the event.
    await Promise.resolve();
    await Promise.resolve();
    callkeep.__emit('endCall', { callUUID: LOWER });

    expect(call.toggleHold).toHaveBeenCalled();
    expect(call.sendDigits).toHaveBeenCalledWith('5');
    expect(call.self.mute).toHaveBeenCalled();
    // Still ringing, so ending it declines it.
    expect(call.reject).toHaveBeenCalled();
  });
});
