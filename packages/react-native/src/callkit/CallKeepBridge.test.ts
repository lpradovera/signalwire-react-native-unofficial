import RNCallKeep from 'react-native-callkeep';
import { BehaviorSubject, Subject } from 'rxjs';

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
});
