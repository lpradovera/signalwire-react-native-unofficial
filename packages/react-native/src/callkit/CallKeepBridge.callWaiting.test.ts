/**
 * Call waiting (decision 17): the same three modes on iOS and Android.
 *
 * - 'full' (the default): a second call rings during a live one and can be
 *   answered with Hold & Accept or End & Accept, or declined; the two calls
 *   swap; a second outbound call holds the first. Two calls at most.
 * - 'endAndAccept': a second call rings, and answering it ends the first.
 * - 'single': a second incoming call is refused as busy, a second dial with
 *   CallInProgressError.
 */
import RNCallKeep from '@signalwire/react-native-callkeep';
import { resetCallHoldStateForTesting } from '@signalwire/react';
import { BehaviorSubject, Subject } from 'rxjs';

import { getAudioRouteController, resetAudioRouteControllerForTesting } from '../audio/AudioRouteController';
import { CallInProgressError } from '../errors';
import { CallKeepBridge } from './CallKeepBridge';

import type { CallWaitingMode } from './CallKeepBridge';

const mockPlatform = { OS: 'ios' as 'ios' | 'android', Version: 35 };

jest.mock('react-native', () => ({
  get Platform() {
    return mockPlatform;
  },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
  PermissionsAndroid: {
    requestMultiple: async (permissions: string[]) =>
      Object.fromEntries(permissions.map((permission) => [permission, 'granted']))
  },
  NativeModules: { RNCallKeep: { setup: () => undefined }, InCallManager: { start: () => undefined } }
}));

const callkeep = RNCallKeep as unknown as typeof RNCallKeep & {
  __reset: () => void;
  __emit: (event: string, payload: unknown) => void;
};

const order: string[] = [];

/** An SDK call, rc.5's hold included: toggleHold() flips a private flag once it resolves. */
function sdkCall(id: string, direction: 'inbound' | 'outbound', status = 'new') {
  const status$ = new BehaviorSubject(status);
  const call = {
    id,
    direction,
    from: '+15550001111',
    fromName: `Caller ${id}`,
    status$,
    get status() {
      return status$.value;
    },
    _holdState: false,
    toggleHold: jest.fn(async () => {
      order.push(`${call._holdState ? 'unhold' : 'hold'} ${id}`);
      await Promise.resolve();
      call._holdState = !call._holdState;
    }),
    answer: jest.fn(() => order.push(`answer ${id}`)),
    reject: jest.fn(() => order.push(`reject ${id}`)),
    hangup: jest.fn(async () => {
      order.push(`hangup ${id}`);
    })
  };
  return call;
}

type FakeCall = ReturnType<typeof sdkCall>;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
};

describe.each(['ios', 'android'] as const)('call waiting on %s', (os) => {
  let bridge: CallKeepBridge;
  let incoming$: Subject<unknown[]>;
  let inbound: FakeCall[];

  async function setUp(callWaiting?: CallWaitingMode): Promise<void> {
    bridge = new CallKeepBridge();
    await bridge.setup({ appName: 'Demo', ...(callWaiting ? { callWaiting } : {}) });
    incoming$ = new Subject<unknown[]>();
    inbound = [];
    bridge.bindClient({ session: { incomingCalls$: incoming$, incomingCalls: [] } } as never);
  }

  beforeEach(() => {
    mockPlatform.OS = os;
    jest.clearAllMocks();
    callkeep.__reset();
    resetCallHoldStateForTesting();
    order.length = 0;
    (RNCallKeep.answerIncomingCall as jest.Mock).mockImplementation((uuid: string) => order.push(`native answer ${uuid}`));
    (RNCallKeep.setOnHold as jest.Mock).mockImplementation((uuid: string, held: boolean) =>
      order.push(`native ${held ? 'hold' : 'unhold'} ${uuid}`)
    );
  });

  afterEach(() => {
    bridge.destroy();
    resetAudioRouteControllerForTesting();
  });

  /** A connected outbound call A. */
  function liveOutbound(id = 'a'): { call: FakeCall; uuid: string } {
    const call = sdkCall(id, 'outbound');
    const uuid = bridge.trackCall(call as never, `/private/${id}`, id);
    call.status$.next('connected');
    return { call, uuid };
  }

  /** An SDK inbound call ringing. */
  function ring(id: string): { call: FakeCall; uuid: string } {
    const call = sdkCall(id, 'inbound', 'ringing');
    inbound.push(call);
    incoming$.next([...inbound]);
    return { call, uuid: bridge.registry.uuidForCall(call as never) ?? '' };
  }

  describe("'full' (the default)", () => {
    beforeEach(() => setUp());

    it('reports up to two calls to CallKit, and keeps calls running when the activity closes (Android)', () => {
      expect(bridge.callWaiting).toBe('full');
      const options = (RNCallKeep.setup as jest.Mock).mock.calls[0][0];
      expect(options.ios).toMatchObject({ maximumCallGroups: '2', maximumCallsPerCallGroup: '1' });
      expect(options.android.endCallsOnHostDestroy).toBe(false);
      expect(bridge.keepsCallsOnUnmount).toBe(true);
    });

    it('rings a second incoming call during a live one', () => {
      liveOutbound();
      const b = ring('b');
      expect(b.uuid).not.toBe('');
      expect(b.call.reject).not.toHaveBeenCalled();
      expect(RNCallKeep.displayIncomingCall).toHaveBeenCalledWith(
        b.uuid,
        expect.any(String),
        expect.any(String),
        'generic',
        false
      );
    });

    it('in-app Hold & Accept: holds A (SDK and native), then answers B natively', async () => {
      const a = liveOutbound();
      const b = ring('b');

      expect(bridge.answerIncomingFromApp(b.call as never, 'hold')).toBe(true);
      await flush();

      expect(order).toEqual([`native hold ${a.uuid}`, `native answer ${b.uuid}`, 'hold a']);
      expect(a.call.hangup).not.toHaveBeenCalled();
    });

    it('in-app End & Accept: ends A, then answers B natively', async () => {
      const a = liveOutbound();
      const b = ring('b');

      bridge.answerIncomingFromApp(b.call as never, 'end');
      await flush();

      expect(order).toEqual(['hangup a', `native answer ${b.uuid}`]);
      expect(bridge.registry.isLive(a.uuid)).toBe(false);
      expect(bridge.registry.isLive(b.uuid)).toBe(true);
    });

    it('native Hold & Accept (CallKit: hold A, answer B) holds A once and answers B', async () => {
      const a = liveOutbound();
      const b = ring('b');

      callkeep.__emit('didToggleHoldCallAction', { callUUID: a.uuid, hold: true });
      callkeep.__emit('answerCall', { callUUID: b.uuid });
      await flush();

      expect(a.call.toggleHold).toHaveBeenCalledTimes(1);
      expect(a.call._holdState).toBe(true);
      expect(b.call.answer).toHaveBeenCalledWith({ audio: true, video: false });
      expect(RNCallKeep.setOnHold).not.toHaveBeenCalled();
    });

    it('a plain native answer (the notification, Telecom) holds the active call first', async () => {
      const a = liveOutbound();
      const b = ring('b');

      callkeep.__emit('answerCall', { callUUID: b.uuid });
      await flush();

      expect(RNCallKeep.setOnHold).toHaveBeenCalledWith(a.uuid, true);
      expect(a.call._holdState).toBe(true);
      expect(b.call.answer).toHaveBeenCalled();
    });

    it('native End & Accept (end A, answer B) ends A and answers B', async () => {
      const a = liveOutbound();
      const b = ring('b');

      callkeep.__emit('endCall', { callUUID: a.uuid });
      callkeep.__emit('answerCall', { callUUID: b.uuid });
      await flush();

      expect(a.call.hangup).toHaveBeenCalled();
      expect(a.call.toggleHold).not.toHaveBeenCalled();
      expect(b.call.answer).toHaveBeenCalled();
    });

    it('declining the waiting call leaves the live one alone', () => {
      const a = liveOutbound();
      const b = ring('b');
      callkeep.__emit('endCall', { callUUID: b.uuid });
      expect(b.call.reject).toHaveBeenCalled();
      expect(a.call.hangup).not.toHaveBeenCalled();
      expect(a.call.toggleHold).not.toHaveBeenCalled();
      expect(bridge.registry.isLive(a.uuid)).toBe(true);
    });

    it('applies the hold flag CallKit and Telecom send, never toggling blindly', async () => {
      const a = liveOutbound();
      callkeep.__emit('didToggleHoldCallAction', { callUUID: a.uuid, hold: true });
      callkeep.__emit('didToggleHoldCallAction', { callUUID: a.uuid, hold: true });
      await flush();
      expect(order).toEqual(['hold a']);

      callkeep.__emit('didToggleHoldCallAction', { callUUID: a.uuid, hold: false });
      callkeep.__emit('didToggleHoldCallAction', { callUUID: a.uuid, hold: false });
      await flush();
      expect(order).toEqual(['hold a', 'unhold a']);
    });

    it('tells the native UI the real state when a hold fails', async () => {
      const a = liveOutbound();
      a.call.toggleHold.mockRejectedValueOnce(new Error('rpc timeout'));
      callkeep.__emit('didToggleHoldCallAction', { callUUID: a.uuid, hold: true });
      await flush();
      expect(RNCallKeep.setOnHold).toHaveBeenLastCalledWith(a.uuid, false);
    });

    it('mirrors an in-app hold to the native UI', () => {
      const a = liveOutbound();
      bridge.mirrorHold(a.call as never, true);
      expect(RNCallKeep.setOnHold).toHaveBeenCalledWith(a.uuid, true);
    });

    it('lets a second outbound call through while one is live, and refuses a third', () => {
      liveOutbound('a');
      expect(() => bridge.assertCanDial()).not.toThrow();
      liveOutbound('b');
      expect(RNCallKeep.startCall).toHaveBeenCalledTimes(2);
      expect(() => bridge.assertCanDial()).toThrow(CallInProgressError);
      const c = sdkCall('c', 'outbound');
      expect(() => bridge.trackCall(c as never, '/private/c', 'c')).toThrow(CallInProgressError);
      expect(c.hangup).toHaveBeenCalled();
    });

    it('refuses a third incoming call as busy', () => {
      liveOutbound('a');
      ring('b');
      const c = ring('c');
      expect(c.call.reject).toHaveBeenCalledTimes(1);
      expect(RNCallKeep.displayIncomingCall).toHaveBeenCalledTimes(1);
    });

    it('moves the audio session to the call that becomes active', async () => {
      const start = jest.spyOn(getAudioRouteController(), 'start').mockImplementation(() => undefined);
      callkeep.__emit('didActivateAudioSession', {});
      const a = liveOutbound();
      await flush();
      expect(start).toHaveBeenLastCalledWith('audio', a.uuid);
      const b = ring('b');

      bridge.answerIncomingFromApp(b.call as never, 'hold');
      callkeep.__emit('answerCall', { callUUID: b.uuid });
      b.call.status$.next('connected');
      await flush();
      expect(start).toHaveBeenLastCalledWith('audio', b.uuid);

      // Swap back: A resumes, B is held.
      callkeep.__emit('didToggleHoldCallAction', { callUUID: b.uuid, hold: true });
      callkeep.__emit('didToggleHoldCallAction', { callUUID: a.uuid, hold: false });
      await flush();
      expect(start).toHaveBeenLastCalledWith('audio', a.uuid);
    });

    it('hands the session to the held call when the active one ends', async () => {
      const start = jest.spyOn(getAudioRouteController(), 'start').mockImplementation(() => undefined);
      const stop = jest.spyOn(getAudioRouteController(), 'stop').mockImplementation(() => undefined);
      callkeep.__emit('didActivateAudioSession', {});
      const a = liveOutbound();
      await flush();
      const b = ring('b');
      bridge.answerIncomingFromApp(b.call as never, 'hold');
      callkeep.__emit('answerCall', { callUUID: b.uuid });
      b.call.status$.next('connected');
      await flush();
      expect(start).toHaveBeenLastCalledWith('audio', b.uuid);

      b.call.status$.next('destroyed');
      await flush();

      expect(stop).not.toHaveBeenCalled();
      expect(start).toHaveBeenLastCalledWith('audio', a.uuid);
      expect(bridge.registry.isLive(a.uuid)).toBe(true);
    });
  });

  describe("'endAndAccept'", () => {
    beforeEach(() => setUp('endAndAccept'));

    it('reports one call group to CallKit', () => {
      const options = (RNCallKeep.setup as jest.Mock).mock.calls[0][0];
      expect(options.ios).toMatchObject({ maximumCallGroups: '1', maximumCallsPerCallGroup: '1' });
    });

    it('rings a second call, and answering it ends the first', async () => {
      const a = liveOutbound();
      const b = ring('b');
      expect(b.call.reject).not.toHaveBeenCalled();

      bridge.answerIncomingFromApp(b.call as never, 'hold');
      await flush();

      expect(order).toEqual(['hangup a', `native answer ${b.uuid}`]);
      expect(a.call.toggleHold).not.toHaveBeenCalled();
    });

    it('a plain native answer ends the live call too', async () => {
      const a = liveOutbound();
      const b = ring('b');
      callkeep.__emit('answerCall', { callUUID: b.uuid });
      await flush();
      expect(a.call.hangup).toHaveBeenCalled();
      expect(bridge.registry.isLive(a.uuid)).toBe(false);
    });

    it('refuses a second outbound call', () => {
      liveOutbound();
      expect(() => bridge.assertCanDial()).toThrow(CallInProgressError);
    });
  });

  describe("'single'", () => {
    beforeEach(() => setUp('single'));

    it('refuses a second incoming call as busy, showing nothing', () => {
      liveOutbound();
      const b = ring('b');
      expect(b.call.reject).toHaveBeenCalledTimes(1);
      expect(RNCallKeep.displayIncomingCall).not.toHaveBeenCalled();
    });

    it('refuses a second outbound call', () => {
      liveOutbound();
      expect(() => bridge.assertCanDial()).toThrow(CallInProgressError);
    });
  });

  it('ends calls when the activity closes when the app opts in (endCallsOnHostDestroy)', async () => {
    bridge = new CallKeepBridge();
    await bridge.setup({ appName: 'Demo', endCallsOnHostDestroy: true });
    const options = (RNCallKeep.setup as jest.Mock).mock.calls[0][0];
    expect(options.android.endCallsOnHostDestroy).toBe(true);
    expect(bridge.keepsCallsOnUnmount).toBe(false);
  });
});
