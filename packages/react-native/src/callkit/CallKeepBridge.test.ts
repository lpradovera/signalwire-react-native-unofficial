import RNCallKeep from 'react-native-callkeep';
import InCallManager from 'react-native-incall-manager';
import { BehaviorSubject, Observable, Subject } from 'rxjs';

import { getAudioRouteController, resetAudioRouteControllerForTesting } from '../audio/AudioRouteController';
import { CallKeepBridge } from './CallKeepBridge';

// The audio controller checks that incall-manager's native module is linked.
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: { InCallManager: { start: jest.fn() } }
}));

const callkeep = RNCallKeep as unknown as typeof RNCallKeep & {
  __emit: (event: string, payload: unknown) => void;
  __reset: () => void;
  __useLegacyApi: () => void;
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

    callkeep.__emit('endCall', { callUUID: uuid });

    expect(call.hangup).toHaveBeenCalled();
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

    expect(call.toggleHold).toHaveBeenCalled();
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

  it('reports the native call ended when the SDK call disconnects', async () => {
    await bridge.setup({ appName: 'Demo' });
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient(createClient(incoming$) as never);
    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    const call = createCall('c1');
    incoming$.next([call]);

    call._status$.next('disconnected');

    expect(RNCallKeep.reportEndCallWithUUID).toHaveBeenCalledWith(uuid, expect.any(Number));
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

  it('destroy removes its own native listeners', async () => {
    await bridge.setup({ appName: 'Demo' });
    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    const applyIntent = jest.spyOn(bridge.registry, 'applyIntent');
    bridge.destroy();

    callkeep.__emit('answerCall', { callUUID: uuid });

    expect(applyIntent).not.toHaveBeenCalled();
  });

  it('destroy removes its own native listeners on callkeep 4.3.0-4.3.8, whose addEventListener returns nothing', async () => {
    // Left subscribed, a destroyed bridge adopts the next push too, and its
    // own tick later ends the live bridge's answered call as missed.
    callkeep.__useLegacyApi();
    const old = new CallKeepBridge();
    await old.setup({ appName: 'Demo' });
    const appEndCall = jest.fn();
    RNCallKeep.addEventListener('endCall', appEndCall);
    old.destroy();
    await bridge.setup({ appName: 'Demo' });
    const display = jest.spyOn(old.registry, 'adoptNativeEntry');
    const answer = jest.spyOn(old.registry, 'applyIntent');

    callkeep.__emit('didDisplayIncomingCall', {
      callUUID: 'next-uuid',
      handle: '+15551234567',
      localizedCallerName: 'Ada',
      fromPushKit: '1'
    });
    callkeep.__emit('answerCall', { callUUID: 'next-uuid' });
    callkeep.__emit('endCall', { callUUID: 'other' });

    expect(display).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
    expect(bridge.registry.entryForUuid('next-uuid')?.intent).toBe('answer');
    // The app's handler, added after the bridge's, stays.
    expect(appEndCall).toHaveBeenCalledTimes(1);
  });

  it("destroy leaves the app's own callkeep handlers in place", async () => {
    // callkeep's removeEventListener(type) with no handler drops every
    // handler of that type in the process, the app's included.
    const appEndCall = jest.fn();
    RNCallKeep.addEventListener('endCall', appEndCall);
    await bridge.setup({ appName: 'Demo' });

    bridge.destroy();
    callkeep.__emit('endCall', { callUUID: 'x' });

    expect(appEndCall).toHaveBeenCalledTimes(1);
  });

  it("destroying a second bridge leaves the first one's handlers in place", async () => {
    await bridge.setup({ appName: 'Demo' });
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient(createClient(incoming$) as never);
    const call = createCall('c1');
    incoming$.next([call]);
    const uuid = (RNCallKeep.displayIncomingCall as jest.Mock).mock.calls[0]?.[0] as string;

    const other = new CallKeepBridge();
    await other.setup({ appName: 'Other' });
    other.destroy();
    callkeep.__emit('answerCall', { callUUID: uuid });

    expect(call.answer).toHaveBeenCalled();
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

  it('stops showing SDK calls in CallKit once the client is unbound', async () => {
    await bridge.setup({ appName: 'Demo' });
    const incoming$ = new Subject<unknown[]>();
    const unbind = bridge.bindClient(createClient(incoming$) as never);

    unbind();
    incoming$.next([createCall('c1')]);

    expect(RNCallKeep.displayIncomingCall).not.toHaveBeenCalled();
  });

  it('subscribes to a client once however often it is bound', async () => {
    await bridge.setup({ appName: 'Demo' });
    let subscriptions = 0;
    const incoming$ = new Subject<unknown[]>();
    const counted$ = new Observable<unknown[]>((subscriber) => {
      subscriptions += 1;
      return incoming$.subscribe(subscriber);
    });
    const client = { session: { incomingCalls$: counted$ } };

    bridge.bindClient(client as never);
    bridge.bindClient(client as never);
    bridge.bindClient(client as never);

    expect(subscriptions).toBe(1);
  });

  it('holds a speaker tap made while an outbound call rings until its session starts', async () => {
    // A tap applied outside the session was undone at connect, or, for a
    // call cancelled while ringing, left incall-manager reconfigured in the
    // idle app.
    resetAudioRouteControllerForTesting();
    await bridge.setup({ appName: 'Demo' });
    const call = createCall('out-ring');
    bridge.trackCall(call as never, '/public/room', 'Support');

    getAudioRouteController().setSpeakerOn(true);
    expect(InCallManager.setForceSpeakerphoneOn).not.toHaveBeenCalled();

    call.status$.next('connected');
    await Promise.resolve();
    expect(InCallManager.start).toHaveBeenCalled();
    expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenLastCalledWith(true);
  });

  it("keeps a client bound until every binder has unbound it", async () => {
    // Two providers, or a provider and the app's own getCallKit().bindClient.
    await bridge.setup({ appName: 'Demo' });
    const incoming$ = new Subject<unknown[]>();
    const client = createClient(incoming$) as never;
    const unbindA = bridge.bindClient(client);
    const unbindB = bridge.bindClient(client);

    unbindA();
    unbindA();
    incoming$.next([createCall('c1')]);
    expect(RNCallKeep.displayIncomingCall).toHaveBeenCalledTimes(1);

    unbindB();
    incoming$.next([createCall('c2')]);
    expect(RNCallKeep.displayIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('binds a client afresh after its last binder unbound it', async () => {
    await bridge.setup({ appName: 'Demo' });
    const incoming$ = new Subject<unknown[]>();
    const client = createClient(incoming$) as never;
    bridge.bindClient(client)();

    bridge.bindClient(client);
    incoming$.next([createCall('c1')]);

    expect(RNCallKeep.displayIncomingCall).toHaveBeenCalledTimes(1);
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

  /** The SDK's own answer to "does this call carry video": WebRTCCall.mediaDirections. */
  const VOICE = { audio: 'sendrecv', video: 'inactive' };
  const VIDEO = { audio: 'sendrecv', video: 'sendrecv' };

  it('starts a voice call in voice mode even when the app supports video', async () => {
    // The mode used to follow the app's supportsVideo, so every call from a
    // video-capable app started in video mode, on the loudspeaker.
    resetAudioRouteControllerForTesting();
    await bridge.setup({ appName: 'Demo', supportsVideo: true });

    const call = { ...createCall('voice-1'), mediaDirections: VOICE };
    const uuid = bridge.trackCall(call as never, '/public/agent', 'Agent');
    call.status$.next('connected');
    await Promise.resolve();

    expect(RNCallKeep.startCall).toHaveBeenCalledWith(uuid, '/public/agent', 'Agent', 'generic', false);
    expect(InCallManager.start).toHaveBeenCalledWith({ media: 'audio' });
    // incall-manager's own start sets the route for the media; nothing is forced.
    expect(getAudioRouteController().route).toBe('earpiece');
  });

  it('starts a video call in video mode, on the loudspeaker', async () => {
    resetAudioRouteControllerForTesting();
    await bridge.setup({ appName: 'Demo', supportsVideo: true });

    const call = { ...createCall('video-1'), mediaDirections: VIDEO };
    const uuid = bridge.trackCall(call as never, '/public/room', 'Room');
    call.status$.next('connected');
    await Promise.resolve();

    expect(RNCallKeep.startCall).toHaveBeenCalledWith(uuid, '/public/room', 'Room', 'generic', true);
    expect(InCallManager.start).toHaveBeenCalledWith({ media: 'video' });
    // incall-manager's own start sets the route for the media; nothing is forced.
    expect(getAudioRouteController().route).toBe('speaker');
  });

  it('counts video in either direction, receive-only included, as a video call', async () => {
    resetAudioRouteControllerForTesting();
    await bridge.setup({ appName: 'Demo', supportsVideo: true });

    const call = { ...createCall('recv-1'), mediaDirections: { audio: 'sendrecv', video: 'recvonly' } };
    const uuid = bridge.trackCall(call as never, '/public/room', 'Room');

    expect(RNCallKeep.startCall).toHaveBeenCalledWith(uuid, '/public/room', 'Room', 'generic', true);
  });

  it('never reports video to a CallKit provider set up without it', async () => {
    // The provider was configured with supportsVideo false: no video button,
    // so the call is reported as a voice call even though its audio session
    // still runs in video mode.
    resetAudioRouteControllerForTesting();
    await bridge.setup({ appName: 'Demo' });

    const call = { ...createCall('video-2'), mediaDirections: VIDEO };
    const uuid = bridge.trackCall(call as never, '/public/room', 'Room');
    call.status$.next('connected');
    await Promise.resolve();

    expect(RNCallKeep.startCall).toHaveBeenCalledWith(uuid, '/public/room', 'Room', 'generic', false);
    expect(InCallManager.start).toHaveBeenCalledWith({ media: 'video' });
  });

  it("falls back to the app's supportsVideo for a call that does not report its media", async () => {
    // trackCall is public; a Call without mediaDirections keeps main's behaviour.
    resetAudioRouteControllerForTesting();
    await bridge.setup({ appName: 'Demo', supportsVideo: true });

    const call = createCall('legacy-1');
    const uuid = bridge.trackCall(call as never, '/public/room', 'Room');
    call.status$.next('connected');
    await Promise.resolve();

    expect(RNCallKeep.startCall).toHaveBeenCalledWith(uuid, '/public/room', 'Room', 'generic', true);
    expect(InCallManager.start).toHaveBeenCalledWith({ media: 'video' });
  });

  it("takes an inbound call's type and audio mode from its own media", async () => {
    resetAudioRouteControllerForTesting();
    await bridge.setup({ appName: 'Demo', supportsVideo: true });
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient(createClient(incoming$) as never);

    const call = { ...createCall('in-voice'), mediaDirections: VOICE };
    incoming$.next([call]);
    const uuid = (RNCallKeep.displayIncomingCall as jest.Mock).mock.calls[0]?.[0] as string;
    expect(RNCallKeep.displayIncomingCall).toHaveBeenCalledWith(uuid, '+15551234', 'Ada', 'generic', false);

    callkeep.__emit('answerCall', { callUUID: uuid });
    await Promise.resolve();
    expect(InCallManager.start).toHaveBeenCalledWith({ media: 'audio' });
  });

  // @signalwire/js 4.0.0-rc.2 reports any offer with a sending m=video as
  // video: 'sendrecv' before the answer, 'recvonly' after it and once
  // connected, although the registry answers it { audio: true, video: false }.
  const OFFERED_VIDEO = { audio: 'sendrecv', video: 'sendrecv' };
  const ANSWERED_VIDEO_OFFER = { audio: 'sendrecv', video: 'recvonly' };

  it.each([false, true])(
    'answers an inbound call from a video caller as voice, on the receiver (supportsVideo %s)',
    async (supportsVideo) => {
      resetAudioRouteControllerForTesting();
      await bridge.setup({ appName: 'Demo', supportsVideo });
      const incoming$ = new Subject<unknown[]>();
      bridge.bindClient(createClient(incoming$) as never);

      const call = { ...createCall('in-video-offer'), mediaDirections: OFFERED_VIDEO };
      incoming$.next([call]);
      const uuid = (RNCallKeep.displayIncomingCall as jest.Mock).mock.calls[0]?.[0] as string;
      expect(RNCallKeep.displayIncomingCall).toHaveBeenCalledWith(uuid, '+15551234', 'Ada', 'generic', false);

      callkeep.__emit('answerCall', { callUUID: uuid });
      await Promise.resolve();
      call.mediaDirections = ANSWERED_VIDEO_OFFER;
      call.status$.next('connected');
      await Promise.resolve();

      expect(call.answer).toHaveBeenCalledWith({ audio: true, video: false });
      expect(InCallManager.start).toHaveBeenCalledTimes(1);
      expect(InCallManager.start).toHaveBeenCalledWith({ media: 'audio' });
      expect(InCallManager.setForceSpeakerphoneOn).not.toHaveBeenCalledWith(true);
    }
  );

  it("takes an inbound call's media from how the registry answers it", async () => {
    // One source: were the registry's answer to take video, the bridge must
    // not go on showing and starting the call as voice.
    const isolated = {} as {
      Bridge: typeof CallKeepBridge;
      callkeep: typeof callkeep;
      incall: typeof InCallManager;
    };
    jest.isolateModules(() => {
      jest.doMock('./CallRegistry', () => ({
        ...jest.requireActual<typeof import('./CallRegistry')>('./CallRegistry'),
        INBOUND_ANSWER: { audio: true, video: true }
      }));
      isolated.Bridge = (require('./CallKeepBridge') as typeof import('./CallKeepBridge')).CallKeepBridge;
      isolated.callkeep = (require('react-native-callkeep') as { default: typeof callkeep }).default;
      isolated.incall = (require('react-native-incall-manager') as { default: typeof InCallManager }).default;
    });
    jest.dontMock('./CallRegistry');
    // The controller lives on globalThis; dropped, the isolated copy makes its own.
    resetAudioRouteControllerForTesting();
    const videoBridge = new isolated.Bridge();
    await videoBridge.setup({ appName: 'Demo', supportsVideo: true });
    const incoming$ = new Subject<unknown[]>();
    videoBridge.bindClient(createClient(incoming$) as never);

    incoming$.next([{ ...createCall('in-answered-video'), mediaDirections: VOICE }]);
    const display = isolated.callkeep.displayIncomingCall as jest.Mock;
    const uuid = display.mock.calls[0]?.[0] as string;
    expect(display).toHaveBeenCalledWith(uuid, '+15551234', 'Ada', 'generic', true);
    isolated.callkeep.__emit('answerCall', { callUUID: uuid });
    await Promise.resolve();

    expect(isolated.incall.start).toHaveBeenCalledWith({ media: 'video' });
    videoBridge.destroy();
    resetAudioRouteControllerForTesting();
  });

  it('keeps a pushed call on the receiver when a video caller’s call fuses', async () => {
    resetAudioRouteControllerForTesting();
    await bridge.setup({ appName: 'Demo', supportsVideo: true });
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient(createClient(incoming$) as never);
    const uuid = bridge.reportIncomingPush({ callId: 'c-fuse', from: '+15551234', fromName: 'Ada' });
    expect(RNCallKeep.displayIncomingCall).toHaveBeenCalledWith(uuid, '+15551234', 'Ada', 'generic', false);
    callkeep.__emit('answerCall', { callUUID: uuid });
    await Promise.resolve();

    const call = { ...createCall('c-fuse'), mediaDirections: ANSWERED_VIDEO_OFFER };
    incoming$.next([call]);
    call.status$.next('connected');
    await Promise.resolve();

    expect(InCallManager.start).toHaveBeenCalledTimes(1);
    expect(InCallManager.start).toHaveBeenCalledWith({ media: 'audio' });
    expect(InCallManager.setForceSpeakerphoneOn).not.toHaveBeenCalledWith(true);
  });

  it('starts a pushed call’s audio when its call connects, with that call’s media', async () => {
    // A push answered before its SDK call exists has no media to start with,
    // and incall-manager's mode can't change once it has started. Its audio
    // waits for the call placed for it.
    resetAudioRouteControllerForTesting();
    await bridge.setup({ appName: 'Demo', supportsVideo: true });
    const uuid = bridge.reportIncomingPush({ callId: 'c-push', from: '+15551234', fromName: 'Ada' });
    callkeep.__emit('answerCall', { callUUID: uuid });
    await Promise.resolve();
    expect(InCallManager.start).not.toHaveBeenCalled();

    bridge.beginBridgeDial(uuid);
    const call = { ...createCall('bridge-1'), mediaDirections: VOICE };
    bridge.trackCall(call as never, '/private/parked', 'Ada');
    bridge.endBridgeDial();
    call.status$.next('connected');
    await Promise.resolve();

    expect(InCallManager.start).toHaveBeenCalledTimes(1);
    expect(InCallManager.start).toHaveBeenCalledWith({ media: 'audio' });
    // incall-manager's own start sets the route for the media; nothing is forced.
    expect(getAudioRouteController().route).toBe('earpiece');
  });

  it('starts a pushed call whose bridge call is video in video mode', async () => {
    resetAudioRouteControllerForTesting();
    await bridge.setup({ appName: 'Demo', supportsVideo: true });
    const uuid = bridge.reportIncomingPush({ callId: 'c-push-v', from: '+15551234', fromName: 'Ada' });
    callkeep.__emit('answerCall', { callUUID: uuid });

    const call = { ...createCall('bridge-v'), mediaDirections: VIDEO };
    expect(bridge.bindBridgeCall(uuid, call as never)).toBe(true);
    call.status$.next('connected');
    await Promise.resolve();

    expect(InCallManager.start).toHaveBeenCalledWith({ media: 'video' });
  });

  it('reads a destroyed call’s media without throwing', async () => {
    // The SDK's mediaDirections getter throws once the call is destroyed.
    resetAudioRouteControllerForTesting();
    await bridge.setup({ appName: 'Demo' });
    const call = createCall('gone');
    Object.defineProperty(call, 'mediaDirections', {
      get: () => {
        throw new Error('Main peer connection not found');
      }
    });

    expect(() => bridge.trackCall(call as never, '/public/room', 'Room')).not.toThrow();
    expect(RNCallKeep.startCall).toHaveBeenCalledWith(expect.any(String), '/public/room', 'Room', 'generic', false);
  });

  it("leaves a running call's route alone when another call rings", async () => {
    resetAudioRouteControllerForTesting();
    await bridge.setup({ appName: 'Demo', supportsVideo: true });
    const active = { ...createCall('video-3'), mediaDirections: VIDEO };
    bridge.trackCall(active as never, '/public/room', 'Room');
    active.status$.next('connected');
    await Promise.resolve();
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient(createClient(incoming$) as never);

    incoming$.next([{ ...createCall('in-voice-2'), mediaDirections: VOICE }]);

    // incall-manager's own start sets the route for the media; nothing is forced.
    expect(getAudioRouteController().route).toBe('speaker');
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
    call.status$.next('disconnected');

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
