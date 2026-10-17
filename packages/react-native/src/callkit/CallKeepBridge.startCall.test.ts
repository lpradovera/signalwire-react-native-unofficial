import RNCallKeep from '@signalwire/react-native-callkeep';
import { BehaviorSubject } from 'rxjs';

import { resetAudioRouteControllerForTesting } from '../audio/AudioRouteController';
import { CallKeepBridge } from './CallKeepBridge';

import type { StartCallRequest } from './CallKeepBridge';

// callkeep linked: setup() checks for its native module.
jest.mock('react-native', () => ({ Platform: { OS: 'ios' }, NativeModules: { RNCallKeep: { setup: () => undefined } } }));

const callkeep = RNCallKeep as unknown as typeof RNCallKeep & {
  __emit: (event: string, payload: unknown) => void;
  __reset: () => void;
};

function createCall(id: string) {
  return { id, status$: new BehaviorSubject('new'), status: 'new', hangup: jest.fn(async () => undefined) };
}

describe('Recents and Siri call-back', () => {
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

  it('keeps calls in Recents by default, and lets the app turn it off', async () => {
    await bridge.setup({ appName: 'Demo' });
    expect((RNCallKeep.setup as jest.Mock).mock.calls[0][0].ios.includesCallsInRecents).toBe(true);

    bridge.destroy();
    bridge = new CallKeepBridge();
    await bridge.setup({ appName: 'Demo', includesCallsInRecents: false });
    expect((RNCallKeep.setup as jest.Mock).mock.calls[1][0].ios.includesCallsInRecents).toBe(false);
  });

  it('emits a call-back the user started from Recents or Siri', async () => {
    await bridge.setup({ appName: 'Demo' });
    const requests: StartCallRequest[] = [];
    bridge.startCallRequested$.subscribe((request) => requests.push(request));

    callkeep.__emit('didReceiveStartCallAction', { handle: '/private/alice', video: false });
    callkeep.__emit('didReceiveStartCallAction', { handle: '+15551230000', name: 'Bob', video: true });

    expect(requests).toEqual([
      { handle: '/private/alice', displayName: undefined, video: false },
      { handle: '+15551230000', displayName: 'Bob', video: true }
    ]);
  });

  it("ignores the start action CallKit reports for the app's own outbound call", async () => {
    await bridge.setup({ appName: 'Demo' });
    const requests: StartCallRequest[] = [];
    bridge.startCallRequested$.subscribe((request) => requests.push(request));

    const uuid = bridge.trackCall(createCall('a') as never, '/private/alice', 'Alice');
    callkeep.__emit('didReceiveStartCallAction', { handle: '/private/alice', callUUID: uuid });

    expect(requests).toEqual([]);
  });

  it('ignores a start action with no handle', async () => {
    await bridge.setup({ appName: 'Demo' });
    const requests: StartCallRequest[] = [];
    bridge.startCallRequested$.subscribe((request) => requests.push(request));
    callkeep.__emit('didReceiveStartCallAction', { handle: '' });
    expect(requests).toEqual([]);
  });

  it('holds a cold-start call-back, replayed before JavaScript listened, for the first subscriber only', () => {
    // A tap in Recents launches the app; callkeep replays the start action
    // in didLoadWithEvents, before setup() and before the app subscribes.
    callkeep.__emit('didLoadWithEvents', [
      { name: 'RNCallKeepDidReceiveStartCallAction', data: { handle: '/private/alice', video: false } }
    ]);

    const first: StartCallRequest[] = [];
    const second: StartCallRequest[] = [];
    bridge.startCallRequested$.subscribe((request) => first.push(request));
    bridge.startCallRequested$.subscribe((request) => second.push(request));

    expect(first).toEqual([{ handle: '/private/alice', displayName: undefined, video: false }]);
    expect(second).toEqual([]);
  });

  it('drops a held call-back nobody took within a minute', () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    callkeep.__emit('didLoadWithEvents', [
      { name: 'RNCallKeepDidReceiveStartCallAction', data: { handle: '/private/alice' } }
    ]);
    now += 61_000;
    const requests: StartCallRequest[] = [];
    bridge.startCallRequested$.subscribe((request) => requests.push(request));
    expect(requests).toEqual([]);
    (Date.now as jest.Mock).mockRestore();
  });

  it('stops listening on destroy', async () => {
    await bridge.setup({ appName: 'Demo' });
    const requests: StartCallRequest[] = [];
    bridge.startCallRequested$.subscribe((request) => requests.push(request));
    bridge.destroy();
    callkeep.__emit('didReceiveStartCallAction', { handle: '/private/alice' });
    expect(requests).toEqual([]);
    bridge = new CallKeepBridge();
  });
});
