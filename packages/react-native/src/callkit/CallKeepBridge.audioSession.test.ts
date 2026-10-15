import RNCallKeep from 'react-native-callkeep';
import InCallManager from 'react-native-incall-manager';
import { BehaviorSubject } from 'rxjs';

import { resetAudioRouteControllerForTesting } from '../audio/AudioRouteController';
import { CallKeepBridge } from './CallKeepBridge';

// The audio-session gate exists only on iOS; CallKeepBridge.test.ts runs as Android.
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

const callkeep = RNCallKeep as unknown as typeof RNCallKeep & {
  __emit: (event: string, payload: unknown) => void;
  __reset: () => void;
};

function createCall(id: string) {
  return { id, status$: new BehaviorSubject('ringing'), hangup: jest.fn(async () => undefined) };
}

/** Lets the bridge's promise chain settle under fake timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe('CallKeepBridge audio session on iOS', () => {
  let bridge: CallKeepBridge;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    callkeep.__reset();
    resetAudioRouteControllerForTesting();
    bridge = new CallKeepBridge();
    await bridge.setup({ appName: 'Demo' });
  });

  afterEach(() => {
    bridge.destroy();
    jest.useRealTimers();
  });

  it('starts audio when CallKit activates the session, and leaves no fallback timer behind', async () => {
    const call = createCall('out-1');
    bridge.trackCall(call as never, '/public/room', 'Support');
    call.status$.next('connected');
    await flush();
    expect(InCallManager.start).not.toHaveBeenCalled();

    callkeep.__emit('didActivateAudioSession', {});
    await flush();

    expect(InCallManager.start).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('still starts audio after the fallback timeout when the session never activates', async () => {
    const call = createCall('out-2');
    bridge.trackCall(call as never, '/public/room', 'Support');
    call.status$.next('connected');
    await flush();
    expect(InCallManager.start).not.toHaveBeenCalled();

    jest.advanceTimersByTime(3000);
    await flush();

    expect(InCallManager.start).toHaveBeenCalledTimes(1);
  });

  it('starts an outbound call at once when CallKit activated the session before it connected', async () => {
    // CallKit activates the session for an outbound call when the start-call
    // action is fulfilled, before the far end answers. A gate created at
    // `connected` used to wait for an activation that had already happened.
    const call = createCall('out-3');
    bridge.trackCall(call as never, '/public/room', 'Support');
    callkeep.__emit('didActivateAudioSession', {});
    call.status$.next('connected');
    await flush();

    expect(InCallManager.start).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('releases the answer-time and the connect-time wait with one activation', async () => {
    const incoming$ = new BehaviorSubject<unknown[]>([]);
    bridge.bindClient({ session: { incomingCalls$: incoming$ } } as never);
    const call = createCall('in-1');
    incoming$.next([call]);
    const uuid = (RNCallKeep.displayIncomingCall as jest.Mock).mock.calls[0]?.[0] as string;

    callkeep.__emit('answerCall', { callUUID: uuid });
    call.status$.next('connected');
    await flush();
    expect(InCallManager.start).not.toHaveBeenCalled();

    callkeep.__emit('didActivateAudioSession', {});
    await flush();

    expect(InCallManager.start).toHaveBeenCalledTimes(1);
    // Neither wait is left holding a fallback timer.
    expect(jest.getTimerCount()).toBe(0);
  });

  it('waits again once CallKit has deactivated the session', async () => {
    callkeep.__emit('didActivateAudioSession', {});
    callkeep.__emit('didDeactivateAudioSession', {});
    const call = createCall('out-4');
    bridge.trackCall(call as never, '/public/room', 'Support');
    call.status$.next('connected');
    await flush();
    expect(InCallManager.start).not.toHaveBeenCalled();

    callkeep.__emit('didActivateAudioSession', {});
    await flush();
    expect(InCallManager.start).toHaveBeenCalledTimes(1);
  });

  it('counts an activation callkeep replayed from before JavaScript started', async () => {
    callkeep.__emit('didLoadWithEvents', [{ name: 'RNCallKeepDidActivateAudioSession', data: null }]);
    const call = createCall('out-5');
    bridge.trackCall(call as never, '/public/room', 'Support');
    call.status$.next('connected');
    await flush();

    expect(InCallManager.start).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
