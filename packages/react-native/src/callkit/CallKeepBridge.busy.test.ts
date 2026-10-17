import RNCallKeep from '@signalwire/react-native-callkeep';
import { BehaviorSubject, Subject } from 'rxjs';

import { resetAudioRouteControllerForTesting } from '../audio/AudioRouteController';
import { CallKeepBridge } from './CallKeepBridge';

// Android, with callkeep linked; the package's own incoming-call module is not.
jest.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 35 },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
  PermissionsAndroid: {
    requestMultiple: async (permissions: string[]) =>
      Object.fromEntries(permissions.map((permission) => [permission, 'granted']))
  },
  NativeModules: { RNCallKeep: { setup: () => undefined } }
}));

const callkeep = RNCallKeep as unknown as typeof RNCallKeep & {
  __reset: () => void;
  __emit: (event: string, payload: unknown) => void;
};

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

/*
 * One call at a time, inbound too (Len, step 10 E): a second incoming call
 * while one was live was handed to Telecom (displayIncomingCall), which held
 * it RINGING with no sheet over the call screen and no refusal, so it rang
 * where nobody could see it. It is now refused as busy (reject(): a verto.bye
 * with USER_BUSY, SIP 486) and never shown in CallKit or Telecom.
 */
describe('a second incoming call while one is live (Android)', () => {
  let bridge: CallKeepBridge;
  let incoming$: Subject<unknown[]>;

  beforeEach(async () => {
    jest.clearAllMocks();
    callkeep.__reset();
    bridge = new CallKeepBridge();
    await bridge.setup({ appName: 'Demo' });
    incoming$ = new Subject<unknown[]>();
    bridge.bindClient({ session: { incomingCalls$: incoming$, incomingCalls: [] } } as never);
  });

  afterEach(() => {
    bridge.destroy();
    resetAudioRouteControllerForTesting();
  });

  function inbound(id: string): FakeCall & { from: string; fromName: string } {
    const call = createCall(id);
    call.status = 'ringing';
    call.status$.next('ringing');
    return Object.assign(call, { from: '+15550001111', fromName: 'Second' });
  }

  it('refuses an SDK call as busy while an outbound call is live, showing nothing', () => {
    const first = createCall('a');
    const uuid = bridge.trackCall(first as never, '/private/alice', 'Alice');
    const second = inbound('b');

    incoming$.next([second]);

    expect(second.reject).toHaveBeenCalledTimes(1);
    expect(second.answer).not.toHaveBeenCalled();
    expect(RNCallKeep.displayIncomingCall).not.toHaveBeenCalled();
    expect(bridge.registry.entries.map((entry) => entry.uuid)).toEqual([uuid]);
    expect(first.hangup).not.toHaveBeenCalled();
  });

  it('refuses a second SDK call while the first one is still ringing', () => {
    const first = inbound('a');
    incoming$.next([first]);
    expect(RNCallKeep.displayIncomingCall).toHaveBeenCalledTimes(1);

    const second = inbound('b');
    incoming$.next([first, second]);

    expect(second.reject).toHaveBeenCalledTimes(1);
    expect(first.reject).not.toHaveBeenCalled();
    expect(RNCallKeep.displayIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('refuses it once, however often the SDK lists it', () => {
    bridge.trackCall(createCall('a') as never, '/private/alice', 'Alice');
    const second = inbound('b');
    incoming$.next([second]);
    incoming$.next([second]);
    expect(second.reject).toHaveBeenCalledTimes(1);
  });

  it('does not show a push while a call is live, and refuses its SDK call when it comes', () => {
    bridge.trackCall(createCall('a') as never, '/private/alice', 'Alice');

    const pushUuid = bridge.reportIncomingPush({ callId: 'b', from: '+15550001111' });
    expect(RNCallKeep.displayIncomingCall).not.toHaveBeenCalled();
    expect(bridge.registry.isLive(pushUuid)).toBe(false);

    const second = inbound('b');
    incoming$.next([second]);
    expect(second.reject).toHaveBeenCalledTimes(1);
    expect(RNCallKeep.displayIncomingCall).not.toHaveBeenCalled();
  });

  it('ends at once a push the native side already showed while a call is live', () => {
    bridge.trackCall(createCall('a') as never, '/private/alice', 'Alice');

    callkeep.__emit('didDisplayIncomingCall', {
      callUUID: 'native-b',
      handle: '+15550001111',
      localizedCallerName: 'Second',
      fromPushKit: '1',
      payload: { callId: 'b' }
    });

    expect(RNCallKeep.reportEndCallWithUUID).toHaveBeenCalledWith('native-b', expect.any(Number));
    expect(bridge.registry.isLive('native-b')).toBe(false);

    const second = inbound('b');
    incoming$.next([second]);
    expect(second.reject).toHaveBeenCalledTimes(1);
  });

  it('shows the next incoming call once the live one has ended', () => {
    const first = createCall('a');
    bridge.trackCall(first as never, '/private/alice', 'Alice');
    first.status$.next('ended');

    const next = inbound('b');
    incoming$.next([next]);
    expect(next.reject).not.toHaveBeenCalled();
    expect(RNCallKeep.displayIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('asks the app to turn down a parked caller whose push was refused as busy', () => {
    bridge.trackCall(createCall('a') as never, '/private/alice', 'Alice');
    const declined: string[] = [];
    const subscription = bridge.registry.rejectRequested$.subscribe((entry) =>
      declined.push(entry.data?.bridgeToken ?? '')
    );

    bridge.reportIncomingPush({ from: '+15550001111', data: { bridgeToken: 'tok-b' } });

    expect(declined).toEqual(['tok-b']);
    expect(RNCallKeep.displayIncomingCall).not.toHaveBeenCalled();
    subscription.unsubscribe();
  });

  it('does not count a refused push as live: the next dial is allowed after the call ends', () => {
    const first = createCall('a');
    bridge.trackCall(first as never, '/private/alice', 'Alice');
    bridge.reportIncomingPush({ callId: 'b', from: '+15550001111' });
    first.status$.next('ended');
    expect(() => bridge.assertCanDial()).not.toThrow();
  });
});

