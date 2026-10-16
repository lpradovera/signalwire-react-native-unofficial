import RNCallKeep from 'react-native-callkeep';
import { BehaviorSubject } from 'rxjs';

import { resetAudioRouteControllerForTesting } from '../audio/AudioRouteController';
import { CallInProgressError } from '../errors';
import { CallKeepBridge, getCallKit, resetCallKitForTesting } from './CallKeepBridge';
import { createCallKitObserver } from './observer';

// callkeep linked: setup() checks for its native module.
jest.mock('react-native', () => ({ Platform: { OS: 'ios' }, NativeModules: { RNCallKeep: { setup: () => undefined } } }));

const callkeep = RNCallKeep as unknown as typeof RNCallKeep & { __reset: () => void };

function createCall(id: string) {
  const status$ = new BehaviorSubject('new');
  return {
    id,
    status$,
    status: 'new',
    answer: jest.fn(),
    reject: jest.fn(),
    hangup: jest.fn(async () => undefined)
  };
}

type FakeCall = ReturnType<typeof createCall>;

describe('a second outbound call while one is live', () => {
  let bridge: CallKeepBridge;

  beforeEach(async () => {
    jest.clearAllMocks();
    callkeep.__reset();
    bridge = new CallKeepBridge();
    await bridge.setup({ appName: 'Demo' });
  });

  afterEach(() => {
    bridge.destroy();
    resetAudioRouteControllerForTesting();
  });

  const track = (call: FakeCall, handle: string): string =>
    bridge.trackCall(call as never, handle, handle);

  it('is refused up front by assertCanDial, naming the live call', () => {
    expect(() => bridge.assertCanDial()).not.toThrow();
    const uuid = track(createCall('a'), '/private/alice');

    let thrown: unknown;
    try {
      bridge.assertCanDial();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CallInProgressError);
    expect((thrown as CallInProgressError).liveCallUuid).toBe(uuid);
    expect((thrown as CallInProgressError).name).toBe('CallInProgressError');
  });

  it('never reaches CallKit or the registry when it slips past the check', () => {
    const first = createCall('a');
    const second = createCall('b');
    const uuid = track(first, '/private/alice');

    expect(() => track(second, '/private/bob')).toThrow(CallInProgressError);

    expect(RNCallKeep.startCall).toHaveBeenCalledTimes(1);
    expect(second.hangup).toHaveBeenCalled();
    expect(first.hangup).not.toHaveBeenCalled();
    expect(bridge.registry.entries.map((entry) => entry.uuid)).toEqual([uuid]);
    expect(bridge.registry.uuidForCall(second as never)).toBeUndefined();
  });

  it('counts a ringing push as live: CallKit allows one call', () => {
    bridge.reportIncomingPush({ callId: 'in-1', from: '+15551230000' });
    expect(() => bridge.assertCanDial()).toThrow(CallInProgressError);
  });

  it('allows the next call once the first has ended', () => {
    const first = createCall('a');
    track(first, '/private/alice');
    first.status$.next('ended');
    expect(() => bridge.assertCanDial()).not.toThrow();
    expect(() => track(createCall('b'), '/private/bob')).not.toThrow();
    expect(RNCallKeep.startCall).toHaveBeenCalledTimes(2);
  });

  it('lets the bridge dial for an answered push through', () => {
    const uuid = bridge.reportIncomingPush({ from: '+15551230000', data: { bridgeToken: 't' } });
    bridge.registry.applyIntent(uuid, 'answer');
    bridge.beginBridgeDial(uuid);

    expect(() => bridge.assertCanDial()).not.toThrow();
    const call = createCall('bridge');
    expect(track(call, '/private/bridge')).toBe(uuid);
    expect(call.hangup).not.toHaveBeenCalled();
    expect(RNCallKeep.startCall).not.toHaveBeenCalled();
  });

});

describe('the CallKit observer', () => {
  afterEach(() => resetCallKitForTesting());

  it('refuses the dial before the SDK places it while a call is live', async () => {
    const observer = createCallKitObserver();
    expect(() => observer.beforeOutgoingCall?.('/private/alice')).not.toThrow();

    await getCallKit().setup({ appName: 'Demo' });
    getCallKit().trackCall(createCall('a') as never, '/private/alice', 'Alice');
    expect(() => observer.beforeOutgoingCall?.('/private/bob')).toThrow(CallInProgressError);
  });
});
