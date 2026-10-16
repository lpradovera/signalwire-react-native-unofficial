import RNCallKeep from 'react-native-callkeep';
import InCallManager from 'react-native-incall-manager';
import { BehaviorSubject, Subject } from 'rxjs';

import { resetAudioRouteControllerForTesting } from '../audio/AudioRouteController';
import { CallKeepBridge } from './CallKeepBridge';

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));

const callkeep = RNCallKeep as unknown as typeof RNCallKeep & {
  __emit: (event: string, payload: unknown) => void;
  __reset: () => void;
};

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
    self: { mute: jest.fn(async () => undefined), unmute: jest.fn(async () => undefined) },
    _status$: status$
  };
}

function createClient(incoming$: Subject<unknown[]>) {
  return { session: { incomingCalls$: incoming$, incomingCalls: [] } };
}

/** Lets queued promise callbacks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('CallKeepBridge', () => {
  let bridge: CallKeepBridge;

  beforeEach(() => {
    jest.clearAllMocks();
    callkeep.__reset();
    bridge = new CallKeepBridge();
  });

  afterEach(() => bridge.destroy());

  it('setup configures callkeep and marks the device available', async () => {
    await bridge.setup({ appName: 'Demo' });
    expect(RNCallKeep.setup).toHaveBeenCalled();
    expect(RNCallKeep.setAvailable).toHaveBeenCalledWith(true);
  });

  it('setup registers every native event listener it handles', async () => {
    await bridge.setup({ appName: 'Demo' });
    const registered = (RNCallKeep.addEventListener as jest.Mock).mock.calls.map((c) => c[0]);
    expect(registered).toEqual(
      expect.arrayContaining([
        'answerCall',
        'endCall',
        'didPerformDTMFAction',
        'didToggleHoldCallAction',
        'didPerformSetMutedCallAction',
        'didActivateAudioSession'
      ])
    );
  });

  it('reportIncomingPush displays the native incoming call', async () => {
    await bridge.setup({ appName: 'Demo' });
    const uuid = bridge.reportIncomingPush({ callId: 'c1', from: '+15551234', fromName: 'Ada' });
    expect(RNCallKeep.displayIncomingCall).toHaveBeenCalledWith(
      uuid,
      '+15551234',
      'Ada',
      'generic',
      false
    );
  });

  it('generates a v4 UUID for the native layer', async () => {
    await bridge.setup({ appName: 'Demo' });
    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('answerCall from the lock screen answers the fused SDK call', async () => {
    await bridge.setup({ appName: 'Demo' });
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient(createClient(incoming$) as never);

    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    const call = createCall('c1');
    incoming$.next([call]);

    callkeep.__emit('answerCall', { callUUID: uuid });

    expect(call.answer).toHaveBeenCalled();
  });

  it('answerCall before fusion is buffered and applied when the call arrives', async () => {
    await bridge.setup({ appName: 'Demo' });
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient(createClient(incoming$) as never);

    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    callkeep.__emit('answerCall', { callUUID: uuid });

    const call = createCall('c1');
    incoming$.next([call]);

    expect(call.answer).toHaveBeenCalled();
  });

  it('endCall hangs up the SDK call', async () => {
    await bridge.setup({ appName: 'Demo' });
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient(createClient(incoming$) as never);

    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    const call = createCall('c1');
    incoming$.next([call]);
    callkeep.__emit('answerCall', { callUUID: uuid });
    call.status = 'connected';
    call._status$.next('connected');

    callkeep.__emit('endCall', { callUUID: uuid });

    expect(call.hangup).toHaveBeenCalled();
    expect(call.reject).not.toHaveBeenCalled();
  });

  it('declining a ringing SDK call in the native UI rejects it, as without CallKit', async () => {
    // hangup() sends a bye with no cause; reject() sends USER_BUSY, which is
    // what the same Decline sends when callKit is off.
    await bridge.setup({ appName: 'Demo' });
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient(createClient(incoming$) as never);
    const call = createCall('c1');
    incoming$.next([call]);
    const uuid = bridge.registry.uuidForCall(call as never)!;

    callkeep.__emit('endCall', { callUUID: uuid });

    expect(call.reject).toHaveBeenCalled();
    expect(call.hangup).not.toHaveBeenCalled();
    expect(bridge.registry.entryForUuid(uuid)?.state).toBe('ended');
  });

  it('declining a pushed call after it fused rejects it', async () => {
    await bridge.setup({ appName: 'Demo' });
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient(createClient(incoming$) as never);
    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    const call = createCall('c1');
    incoming$.next([call]);

    callkeep.__emit('endCall', { callUUID: uuid });

    expect(call.reject).toHaveBeenCalled();
    expect(call.hangup).not.toHaveBeenCalled();
  });

  it('ending an outbound call that is still ringing hangs it up', async () => {
    await bridge.setup({ appName: 'Demo' });
    const call = createCall('out');
    const uuid = bridge.trackCall(call as never, '/public/room', 'Support');

    callkeep.__emit('endCall', { callUUID: uuid });

    expect(call.hangup).toHaveBeenCalled();
    expect(call.reject).not.toHaveBeenCalled();
  });

  it('endCall while still pending rejects instead of hanging up', async () => {
    await bridge.setup({ appName: 'Demo' });
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient(createClient(incoming$) as never);

    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    callkeep.__emit('endCall', { callUUID: uuid });

    const call = createCall('c1');
    incoming$.next([call]);

    expect(call.reject).toHaveBeenCalled();
    expect(call.hangup).not.toHaveBeenCalled();
  });

  it('DTMF from the native keypad reaches the call', async () => {
    await bridge.setup({ appName: 'Demo' });
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient(createClient(incoming$) as never);
    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    const call = createCall('c1');
    incoming$.next([call]);

    callkeep.__emit('didPerformDTMFAction', { callUUID: uuid, digits: '5' });

    expect(call.sendDigits).toHaveBeenCalledWith('5');
  });

  it('hold toggles the call', async () => {
    await bridge.setup({ appName: 'Demo' });
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient(createClient(incoming$) as never);
    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    const call = createCall('c1');
    incoming$.next([call]);

    callkeep.__emit('didToggleHoldCallAction', { callUUID: uuid, hold: true });
    await flush();

    expect(call.toggleHold).toHaveBeenCalled();
  });

  describe('native hold carries the state CallKit wants', () => {
    function holdableCall(id: string, held = false) {
      // The SDK's toggleHold flips a private flag only once the hold RPC
      // resolves; mirror that.
      // `sent` records what reached the server (verto hold / unhold).
      const call = Object.assign(createCall(id), { _holdState: held, sent: [] as string[] });
      call.toggleHold = jest.fn(async (): Promise<undefined> => {
        call.sent.push(call._holdState ? 'unhold' : 'hold');
        await Promise.resolve();
        call._holdState = !call._holdState;
        return undefined;
      });
      return call;
    }

    async function fused(call: ReturnType<typeof createCall>) {
      await bridge.setup({ appName: 'Demo' });
      const incoming$ = new Subject<unknown[]>();
      bridge.bindClient(createClient(incoming$) as never);
      const uuid = bridge.reportIncomingPush({ callId: call.id });
      incoming$.next([call]);
      return uuid;
    }

    it('does not unhold a call the app already held', async () => {
      // In-app hold (useCall().toggleHold) never reaches CallKit; a later
      // Hold & Accept sends hold: true, which toggled the call back on.
      const call = holdableCall('c1', true);
      const uuid = await fused(call);

      callkeep.__emit('didToggleHoldCallAction', { callUUID: uuid, hold: true });
      await flush();

      expect(call.toggleHold).not.toHaveBeenCalled();
      expect(call._holdState).toBe(true);
    });

    it('applies hold then resume in order, ending unheld', async () => {
      // Both used to read the flag before the first RPC settled, and both held.
      const call = holdableCall('c1');
      const uuid = await fused(call);

      callkeep.__emit('didToggleHoldCallAction', { callUUID: uuid, hold: true });
      callkeep.__emit('didToggleHoldCallAction', { callUUID: uuid, hold: false });
      await flush();

      expect(call.sent).toEqual(['hold', 'unhold']);
      expect(call._holdState).toBe(false);
    });

    it('tells CallKit the real state when the hold fails', async () => {
      const call = holdableCall('c1');
      call.toggleHold = jest.fn(async (): Promise<undefined> => {
        throw new Error('verto.modify failed');
      });
      const uuid = await fused(call);

      callkeep.__emit('didToggleHoldCallAction', { callUUID: uuid, hold: true });
      await flush();

      expect(RNCallKeep.setOnHold).toHaveBeenCalledWith(uuid, false);
    });
  });

  it('native mute mutes the self participant', async () => {
    await bridge.setup({ appName: 'Demo' });
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient(createClient(incoming$) as never);
    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    const call = createCall('c1');
    incoming$.next([call]);

    callkeep.__emit('didPerformSetMutedCallAction', { callUUID: uuid, muted: true });

    expect(call.self.mute).toHaveBeenCalled();
  });

  it('applies a native mute made before the call has a self participant', async () => {
    // The user answers a pushed call and taps Mute while the bridge call is
    // being placed. The mute was dropped while CallKit showed Mute on, and
    // the microphone went live when the call connected.
    await bridge.setup({ appName: 'Demo' });
    const uuid = bridge.reportIncomingPush({ data: { bridgeToken: 't' } });
    callkeep.__emit('answerCall', { callUUID: uuid });
    callkeep.__emit('didPerformSetMutedCallAction', { callUUID: uuid, muted: true });

    const self$ = new BehaviorSubject<unknown>(null);
    const self = { mute: jest.fn(async () => undefined), unmute: jest.fn(async () => undefined) };
    const call = Object.assign(createCall('bridge'), { self: null as unknown, self$ });
    expect(bridge.bindBridgeCall(uuid, call as never)).toBe(true);
    expect(self.mute).not.toHaveBeenCalled();

    call.self = self;
    self$.next(self);

    expect(self.mute).toHaveBeenCalledTimes(1);
  });

  it('applies only the last native mute state made before the call joined', async () => {
    await bridge.setup({ appName: 'Demo' });
    const uuid = bridge.reportIncomingPush({ data: { bridgeToken: 't' } });
    callkeep.__emit('answerCall', { callUUID: uuid });
    callkeep.__emit('didPerformSetMutedCallAction', { callUUID: uuid, muted: true });
    callkeep.__emit('didPerformSetMutedCallAction', { callUUID: uuid, muted: false });

    const self$ = new BehaviorSubject<unknown>(null);
    const self = { mute: jest.fn(async () => undefined), unmute: jest.fn(async () => undefined) };
    const call = Object.assign(createCall('bridge'), { self: null as unknown, self$ });
    bridge.bindBridgeCall(uuid, call as never);
    call.self = self;
    self$.next(self);

    expect(self.mute).not.toHaveBeenCalled();
    expect(self.unmute).toHaveBeenCalledTimes(1);
  });

  it('native unmute unmutes the self participant', async () => {
    await bridge.setup({ appName: 'Demo' });
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient(createClient(incoming$) as never);
    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    const call = createCall('c1');
    incoming$.next([call]);

    callkeep.__emit('didPerformSetMutedCallAction', { callUUID: uuid, muted: false });

    expect(call.self.unmute).toHaveBeenCalled();
  });

  it('reports the native call ended when the SDK call is destroyed', async () => {
    await bridge.setup({ appName: 'Demo' });
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient(createClient(incoming$) as never);
    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    const call = createCall('c1');
    incoming$.next([call]);

    call._status$.next('destroyed');

    expect(RNCallKeep.reportEndCallWithUUID).toHaveBeenCalledWith(uuid, expect.any(Number));
  });

  it('keeps the native call through a transient disconnect the SDK recovers from', async () => {
    // 'disconnected' is the peer connection's state during an ICE blip
    // (Wi-Fi to cellular); the SDK restores the call. Ending it there left a
    // connected SDK call with no CallKit call and no audio session.
    await bridge.setup({ appName: 'Demo' });
    const call = createCall('out');
    const uuid = bridge.trackCall(call as never, '/public/room', 'Support');
    call._status$.next('connected');

    call._status$.next('disconnected');
    call._status$.next('connected');

    expect(RNCallKeep.reportEndCallWithUUID).not.toHaveBeenCalled();
    expect(bridge.registry.isLive(uuid)).toBe(true);
  });

  it('ends the native call as soon as the app hangs up', async () => {
    // hangup() emits 'disconnecting' and reaches 'destroyed' only when the
    // bye settles, up to its 5 s timeout on a bad network.
    await bridge.setup({ appName: 'Demo' });
    const call = createCall('out');
    const uuid = bridge.trackCall(call as never, '/public/room', 'Support');
    call._status$.next('connected');

    call._status$.next('disconnecting');

    expect(RNCallKeep.reportEndCallWithUUID).toHaveBeenCalledWith(uuid, expect.any(Number));
    expect(bridge.registry.isLive(uuid)).toBe(false);
  });

  it('watches a call tracked twice only once', async () => {
    await bridge.setup({ appName: 'Demo' });
    const call = createCall('out');
    const first = bridge.trackCall(call as never, '/public/room', 'Support');
    const second = bridge.trackCall(call as never, '/public/room', 'Support');

    call._status$.next('connected');

    expect(second).toBe(first);
    expect(RNCallKeep.startCall).toHaveBeenCalledTimes(1);
    expect(RNCallKeep.reportConnectedOutgoingCallWithUUID).toHaveBeenCalledTimes(1);
  });

  it('reports an outgoing call connected when its status reaches connected', async () => {
    await bridge.setup({ appName: 'Demo' });
    const call = createCall('c1');
    const uuid = bridge.trackCall(call as never, '/public/room', 'Support');

    call._status$.next('connected');

    expect(RNCallKeep.reportConnectedOutgoingCallWithUUID).toHaveBeenCalledWith(uuid);
  });

  it('trackCall starts a native outgoing call', async () => {
    await bridge.setup({ appName: 'Demo' });
    const uuid = bridge.trackCall(createCall('c1') as never, '/public/room', 'Support');
    expect(RNCallKeep.startCall).toHaveBeenCalledWith(
      uuid,
      '/public/room',
      'Support',
      'generic',
      false
    );
  });

  it('ignores native events for an unknown uuid', async () => {
    await bridge.setup({ appName: 'Demo' });
    expect(() => callkeep.__emit('answerCall', { callUUID: 'nope' })).not.toThrow();
  });

  it('destroy removes every native listener', async () => {
    await bridge.setup({ appName: 'Demo' });
    bridge.destroy();
    expect(RNCallKeep.removeEventListener).toHaveBeenCalled();
  });

  it('setup twice does not double-register listeners', async () => {
    await bridge.setup({ appName: 'Demo' });
    const first = (RNCallKeep.addEventListener as jest.Mock).mock.calls.length;
    await bridge.setup({ appName: 'Demo' });
    expect((RNCallKeep.addEventListener as jest.Mock).mock.calls.length).toBe(first);
  });

  /**
   * Regression: `SignalWireProvider` calls `bindClient` immediately after
   * constructing the client, before it has connected, so `client.session` is
   * undefined. Reading it eagerly threw and red-screened the app on launch.
   * Every other test here mocks a client that already has a session, which is
   * exactly why the crash reached a simulator before it reached a test.
   */
  it('does not throw when bound before the client has a session', () => {
    const isConnected$ = new BehaviorSubject(false);

    expect(() => bridge.bindClient({ isConnected$, session: undefined } as never)).not.toThrow();
  });

  it('subscribes once the client connects and a session exists', async () => {
    await bridge.setup({ appName: 'Demo' });

    const isConnected$ = new BehaviorSubject(false);
    const incoming$ = new Subject<unknown[]>();
    const client = { isConnected$, session: undefined as unknown } as never;

    bridge.bindClient(client);

    // Session appears only once the client is connected, as it does in the SDK.
    (client as { session: unknown }).session = { incomingCalls$: incoming$ };
    isConnected$.next(true);

    incoming$.next([createCall('c1')]);

    expect(RNCallKeep.displayIncomingCall).toHaveBeenCalled();
  });

  it('re-subscribes to the new session after a reconnect', async () => {
    await bridge.setup({ appName: 'Demo' });

    const isConnected$ = new BehaviorSubject(false);
    const first$ = new Subject<unknown[]>();
    const client = { isConnected$, session: { incomingCalls$: first$ } } as never;

    bridge.bindClient(client);
    isConnected$.next(true);

    // A reconnect replaces the session object entirely.
    const second$ = new Subject<unknown[]>();
    (client as { session: unknown }).session = { incomingCalls$: second$ };
    isConnected$.next(false);
    isConnected$.next(true);

    second$.next([createCall('c2')]);

    expect(RNCallKeep.displayIncomingCall).toHaveBeenCalled();
  });

  it('starts the audio session when an outbound call connects', async () => {
    // Outbound calls never reach the native answer handler, which was the only
    // caller of startAudio — so InCallManager never ran for a call the user
    // placed and iOS left the audio session in its default category, giving a
    // connected but silent call.
    resetAudioRouteControllerForTesting();
    await bridge.setup({ appName: 'Demo' });

    const call = createCall('out-1');
    bridge.trackCall(call as never, '/public/room', 'Support');
    call.status$.next('connected');
    await Promise.resolve();

    // Platform.OS is 'android' in this file, so there is no audio-session gate
    // to wait on and the start happens synchronously after the status change.
    expect(InCallManager.start).toHaveBeenCalled();
  });

  it('routes an in-app answer through CallKit so iOS activates audio', async () => {
    await bridge.setup({ appName: 'Demo' });
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient({ session: { incomingCalls$: incoming$ } } as never);
    const call = createCall('c1');
    incoming$.next([call]);

    const handled = bridge.answerIncomingFromApp(call as never);

    expect(handled).toBe(true);
    expect(RNCallKeep.answerIncomingCall).toHaveBeenCalled();
    // The SDK answer comes later, from the native answerCall event — not here.
    expect(call.answer).not.toHaveBeenCalled();
  });

  it('declines to handle an in-app answer for a call it does not know', async () => {
    await bridge.setup({ appName: 'Demo' });
    expect(bridge.answerIncomingFromApp(createCall('stranger') as never)).toBe(false);
    expect(RNCallKeep.answerIncomingCall).not.toHaveBeenCalled();
  });

  it('routes an in-app reject through CallKit', async () => {
    await bridge.setup({ appName: 'Demo' });
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient({ session: { incomingCalls$: incoming$ } } as never);
    const call = createCall('c1');
    incoming$.next([call]);

    expect(bridge.rejectIncomingFromApp(call as never)).toBe(true);
    expect(RNCallKeep.rejectCall).toHaveBeenCalled();
  });

  it('watches a bound bridge call so it tears the native entry down', async () => {
    await bridge.setup({ appName: 'Demo' });
    const uuid = bridge.reportIncomingPush({ callId: 'a-leg-sid' });
    const call = createCall('bridge-leg');

    expect(bridge.bindBridgeCall(uuid, call as never)).toBe(true);
    call.status$.next('destroyed');

    expect(RNCallKeep.reportEndCallWithUUID).toHaveBeenCalled();
  });

  it('reports a bind failure so the caller can hang the orphan call up', async () => {
    await bridge.setup({ appName: 'Demo' });
    expect(bridge.bindBridgeCall('never-existed', createCall('x') as never)).toBe(false);
  });

  describe('cold start — the push was displayed before JavaScript existed', () => {
    it('adopts the native entry, keeping the UUID CallKit is already showing', async () => {
      await bridge.setup({ appName: 'Demo' });

      callkeep.__emit('didDisplayIncomingCall', {
        callUUID: 'native-uuid',
        handle: '+15551234',
        localizedCallerName: 'Ada',
        fromPushKit: '1',
        payload: { callId: 'a-leg', bridgeToken: 'opaque-token' }
      });

      const entry = bridge.registry.entryForUuid('native-uuid');
      expect(entry?.state).toBe('pending-push');
      expect(entry?.handle).toBe('+15551234');
      // The opaque token must survive: JS cannot ask for it later, the push is gone.
      expect(entry?.data).toEqual({ bridgeToken: 'opaque-token' });
    });

    it('ignores calls the app itself displayed, not PushKit', async () => {
      await bridge.setup({ appName: 'Demo' });
      callkeep.__emit('didDisplayIncomingCall', {
        callUUID: 'not-a-push',
        fromPushKit: '0',
        payload: {}
      });
      expect(bridge.registry.entryForUuid('not-a-push')).toBeUndefined();
    });

    it('tolerates the event being replayed', async () => {
      await bridge.setup({ appName: 'Demo' });
      const event = {
        callUUID: 'native-uuid',
        handle: '+15551234',
        fromPushKit: '1',
        payload: { callId: 'a-leg' }
      };
      callkeep.__emit('didDisplayIncomingCall', event);
      callkeep.__emit('didDisplayIncomingCall', event);

      expect(bridge.registry.entries.filter((e) => e.uuid === 'native-uuid')).toHaveLength(1);
    });

    it('answering an adopted entry asks the app to place the bridge call', async () => {
      await bridge.setup({ appName: 'Demo' });
      callkeep.__emit('didDisplayIncomingCall', {
        callUUID: 'native-uuid',
        fromPushKit: '1',
        payload: { bridgeToken: 'opaque-token' }
      });
      const asked: Array<Record<string, string> | undefined> = [];
      bridge.registry.answerRequested$.subscribe((entry) => asked.push(entry.data));

      callkeep.__emit('answerCall', { callUUID: 'native-uuid' });

      expect(asked).toEqual([{ bridgeToken: 'opaque-token' }]);
    });
  });

  it('asks for READ_PHONE_NUMBERS, which the outgoing connection needs', async () => {
    // Declared but ungranted, the call connects and then the app dies with
    // SecurityException inside VoiceConnectionService.createConnection —
    // which reads as a crash on answer, not a missing runtime grant.
    const bridge = new CallKeepBridge();
    await bridge.setup({ appName: 'Demo' });

    const options = (RNCallKeep.setup as jest.Mock).mock.calls[0][0] as {
      android: { additionalPermissions: string[] };
    };

    expect(options.android.additionalPermissions).toContain(
      'android.permission.READ_PHONE_NUMBERS'
    );
  });
});
