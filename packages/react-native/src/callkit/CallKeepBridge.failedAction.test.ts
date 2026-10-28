/**
 * A call action CallKit or Telecom refused (callkeep's didFailCallAction, from
 * the SignalWire callkeep fork). The native side has no such call, so the
 * registry entry is dropped and the SDK call it stands for is hung up: left
 * alone it would run on with no native UI and nothing to end it from.
 */
import RNCallKeep from '@signalwire/react-native-callkeep';
import { BehaviorSubject } from 'rxjs';

import { logger } from '@signalwire/react';
import { resetAudioRouteControllerForTesting } from '../audio/AudioRouteController';
import { CallKeepBridge } from './CallKeepBridge';

const mockPlatform = { OS: 'ios' };
jest.mock('react-native', () => ({
  get Platform() {
    return mockPlatform;
  },
  NativeModules: { RNCallKeep: { setup: () => undefined } }
}));

const callkeep = RNCallKeep as unknown as typeof RNCallKeep & {
  __emit: (event: string, payload: unknown) => void;
  __reset: () => void;
  __useStockEvents: () => void;
};

function createCall(id: string) {
  return { id, status$: new BehaviorSubject('new'), status: 'new', hangup: jest.fn(async () => undefined) };
}

describe('didFailCallAction', () => {
  let bridge: CallKeepBridge;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    callkeep.__reset();
    mockPlatform.OS = 'ios';
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    bridge = new CallKeepBridge();
  });

  afterEach(() => {
    bridge.destroy();
    warn.mockRestore();
    resetAudioRouteControllerForTesting();
  });

  it('drops a call CallKit refused to start and hangs up its SDK call', async () => {
    await bridge.setup({ appName: 'Demo' });
    const call = createCall('out-1');
    const uuid = bridge.trackCall(call as never, '/private/alice', 'Alice');

    callkeep.__emit('didFailCallAction', {
      callUUID: uuid,
      action: 'startCall',
      errorCode: 'MaximumCallGroupsReached',
      error: 'The operation couldn’t be completed.'
    });

    expect(call.hangup).toHaveBeenCalledTimes(1);
    expect(bridge.registry.isLive(uuid)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('MaximumCallGroupsReached'));
  });

  it('matches the call whatever the uuid case', async () => {
    await bridge.setup({ appName: 'Demo' });
    const call = createCall('out-1');
    const uuid = bridge.trackCall(call as never, '/private/alice', 'Alice');

    callkeep.__emit('didFailCallAction', { callUUID: uuid.toUpperCase(), action: 'startCall', errorCode: 'Unknown' });

    expect(bridge.registry.isLive(uuid)).toBe(false);
  });

  it('drops a call whose end CallKit refused because it no longer has it', async () => {
    await bridge.setup({ appName: 'Demo' });
    const call = createCall('out-1');
    const uuid = bridge.trackCall(call as never, '/private/alice', 'Alice');

    callkeep.__emit('didFailCallAction', { callUUID: uuid, action: 'endCall', errorCode: 'UnknownCallUUID' });

    expect(call.hangup).toHaveBeenCalledTimes(1);
    expect(bridge.registry.isLive(uuid)).toBe(false);
  });

  it('drops a call CallKit lost, whatever the refused action', async () => {
    await bridge.setup({ appName: 'Demo' });
    const call = createCall('out-1');
    const uuid = bridge.trackCall(call as never, '/private/alice', 'Alice');

    callkeep.__emit('didFailCallAction', { callUUID: uuid, action: 'setMuted', errorCode: 'UnknownCallUUID' });

    expect(bridge.registry.isLive(uuid)).toBe(false);
  });

  it('keeps a call when CallKit only refused a hold, mute or DTMF it still has the call for', async () => {
    await bridge.setup({ appName: 'Demo' });
    const call = createCall('out-1');
    const uuid = bridge.trackCall(call as never, '/private/alice', 'Alice');

    callkeep.__emit('didFailCallAction', { callUUID: uuid, action: 'setHeld', errorCode: 'InvalidAction' });

    expect(call.hangup).not.toHaveBeenCalled();
    expect(bridge.registry.isLive(uuid)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('setHeld'));
  });

  it("ignores a refusal for a call it doesn't know", async () => {
    await bridge.setup({ appName: 'Demo' });
    expect(() =>
      callkeep.__emit('didFailCallAction', { callUUID: 'nope', action: 'startCall', errorCode: 'Unknown' })
    ).not.toThrow();
  });

  it('drops a call Telecom refused to start on Android', async () => {
    mockPlatform.OS = 'android';
    bridge.destroy();
    bridge = new CallKeepBridge();
    await bridge.setup({ appName: 'Demo' });
    const call = createCall('out-1');
    const uuid = bridge.trackCall(call as never, '+15550001', 'Bob');

    callkeep.__emit('didFailCallAction', { callUUID: uuid, action: 'startCall', errorCode: 'ConnectionRefused' });

    expect(call.hangup).toHaveBeenCalledTimes(1);
    expect(bridge.registry.isLive(uuid)).toBe(false);
  });

  it('works with stock callkeep, which has no such event', () => {
    bridge.destroy();
    callkeep.__reset();
    callkeep.__useStockEvents();
    expect(() => {
      bridge = new CallKeepBridge();
    }).not.toThrow();
  });
});
