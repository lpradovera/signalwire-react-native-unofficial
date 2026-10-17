import RNCallKeep from '@signalwire/react-native-callkeep';
import { BehaviorSubject, Subject } from 'rxjs';

import { resetAudioRouteControllerForTesting } from '../audio/AudioRouteController';
import { CallKeepBridge } from './CallKeepBridge';

// iOS, with callkeep and this package's Siri module linked.
const mockDonateCall = jest.fn<Promise<boolean>, [unknown]>(async () => true);
jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  NativeModules: {
    RNCallKeep: { setup: () => undefined },
    SWSiriCalls: {
      donateCall: (call: unknown) => mockDonateCall(call),
      authorizationStatus: async () => 'authorized',
      requestAuthorization: async () => 'authorized',
      forgetCalls: async () => true
    }
  }
}));

const callkeep = RNCallKeep as unknown as typeof RNCallKeep & { __reset: () => void };

function createCall(id: string, from?: string, fromName?: string) {
  return {
    id,
    from,
    fromName,
    status$: new BehaviorSubject('new'),
    status: 'new',
    answer: jest.fn(),
    hangup: jest.fn(async () => undefined)
  };
}

type FakeCall = ReturnType<typeof createCall>;

function setStatus(call: FakeCall, status: string): void {
  call.status = status;
  call.status$.next(status);
}

/** Lets the donation's promise chain run. */
const flush = () => new Promise<void>((resolve) => setImmediate(() => resolve()));

describe('Siri donations for completed calls', () => {
  let bridge: CallKeepBridge;

  beforeEach(() => {
    jest.clearAllMocks();
    callkeep.__reset();
    bridge = new CallKeepBridge();
  });

  afterEach(() => {
    bridge.destroy();
    resetAudioRouteControllerForTesting();
  });

  it('donates an outgoing call that connected, once, when it ends', async () => {
    await bridge.setup({ appName: 'Demo' });
    const call = createCall('out-1');
    bridge.trackCall(call as never, '/private/rn-device-test', 'Rn Device Test');

    setStatus(call, 'connected');
    await flush();
    expect(mockDonateCall).not.toHaveBeenCalled();

    setStatus(call, 'disconnecting');
    setStatus(call, 'ended');
    await flush();

    expect(mockDonateCall).toHaveBeenCalledTimes(1);
    const donated = mockDonateCall.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(donated).toMatchObject({
      handle: '/private/rn-device-test',
      displayName: 'Rn Device Test',
      outgoing: true,
      video: false
    });
    expect(donated.endedAt as number).toBeGreaterThanOrEqual(donated.startedAt as number);
  });

  it('donates an incoming call as incoming, with the caller', async () => {
    await bridge.setup({ appName: 'Demo' });
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient({ session: { incomingCalls$: incoming$, incomingCalls: [] } } as never);
    const call = createCall('in-1', '/private/alice', 'Alice');
    incoming$.next([call]);

    setStatus(call, 'connected');
    setStatus(call, 'ended');
    await flush();

    expect(mockDonateCall).toHaveBeenCalledTimes(1);
    expect(mockDonateCall.mock.calls[0]?.[0]).toMatchObject({
      handle: '/private/alice',
      displayName: 'Alice',
      outgoing: false
    });
  });

  it('donates nothing for a call that never connected', async () => {
    await bridge.setup({ appName: 'Demo' });
    const call = createCall('out-2');
    bridge.trackCall(call as never, '/private/nobody', 'Nobody');
    setStatus(call, 'failed');
    await flush();
    expect(mockDonateCall).not.toHaveBeenCalled();
  });

  it('follows includesCallsInRecents, and donateCallsToSiri overrides it', async () => {
    await bridge.setup({ appName: 'Demo', includesCallsInRecents: false });
    let call = createCall('out-3');
    bridge.trackCall(call as never, '/private/a', 'A');
    setStatus(call, 'connected');
    setStatus(call, 'ended');
    await flush();
    expect(mockDonateCall).not.toHaveBeenCalled();

    bridge.destroy();
    bridge = new CallKeepBridge();
    await bridge.setup({ appName: 'Demo', includesCallsInRecents: false, donateCallsToSiri: true });
    call = createCall('out-4');
    bridge.trackCall(call as never, '/private/b', 'B');
    setStatus(call, 'connected');
    setStatus(call, 'ended');
    await flush();
    expect(mockDonateCall).toHaveBeenCalledTimes(1);

    bridge.destroy();
    bridge = new CallKeepBridge();
    await bridge.setup({ appName: 'Demo', donateCallsToSiri: false });
    call = createCall('out-5');
    bridge.trackCall(call as never, '/private/c', 'C');
    setStatus(call, 'connected');
    setStatus(call, 'ended');
    await flush();
    expect(mockDonateCall).toHaveBeenCalledTimes(1);
  });
});
