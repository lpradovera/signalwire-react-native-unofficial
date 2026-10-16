import { NativeModules, Platform } from 'react-native';

import {
  forgetPendingVoipCall,
  getPendingVoipCalls,
  getVoipToken,
  watchVoipToken
} from './voipToken';

const listeners: Array<(event: { token?: string }) => void> = [];

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  NativeModules: {},
  NativeEventEmitter: class {
    addListener(_event: string, listener: (e: { token?: string }) => void) {
      listeners.push(listener);
      return { remove: jest.fn() };
    }
  }
}));

describe('voipToken', () => {
  beforeEach(() => {
    listeners.length = 0;
    (NativeModules as Record<string, unknown>).SignalWireVoipPush = {
      getToken: jest.fn(async () => 'cached-token')
    };
    (Platform as { OS: string }).OS = 'ios';
  });

  it('reads the token cached before the bridge existed', async () => {
    // iOS issues the token during launch; a listener alone would never see it.
    await expect(getVoipToken()).resolves.toBe('cached-token');
  });

  it('returns null instead of throwing when the native module is absent', async () => {
    delete (NativeModules as Record<string, unknown>).SignalWireVoipPush;
    await expect(getVoipToken()).resolves.toBeNull();
  });

  it('returns null on Android, where VoIP push does not exist', async () => {
    (Platform as { OS: string }).OS = 'android';
    await expect(getVoipToken()).resolves.toBeNull();
  });

  it('survives a native getToken that rejects', async () => {
    (NativeModules as Record<string, unknown>).SignalWireVoipPush = {
      getToken: jest.fn(async () => {
        throw new Error('bridge gone');
      })
    };
    await expect(getVoipToken()).resolves.toBeNull();
  });

  it('emits the cached token then refreshes, without repeating itself', async () => {
    const seen: string[] = [];
    watchVoipToken((token) => seen.push(token));
    await Promise.resolve();
    await Promise.resolve();

    // A refresh matching the cached value must not re-register the device.
    listeners.forEach((l) => l({ token: 'cached-token' }));
    listeners.forEach((l) => l({ token: 'rotated-token' }));

    expect(seen).toEqual(['cached-token', 'rotated-token']);
  });

  describe('pending calls', () => {
    it('returns every push the app was woken by, not only the last one', async () => {
      // Two pushes before JavaScript ran: a single slot kept only the second,
      // and the first call's answer then went to no registry entry.
      (NativeModules as Record<string, unknown>).SignalWireVoipPush = {
        getToken: jest.fn(async () => null),
        getPendingCalls: jest.fn(async () => [
          { uuid: 'a', callId: 'ca' },
          { uuid: 'b', callId: 'cb' }
        ])
      };
      await expect(getPendingVoipCalls()).resolves.toEqual([
        { uuid: 'a', callId: 'ca' },
        { uuid: 'b', callId: 'cb' }
      ]);
    });

    it('skips entries without a uuid', async () => {
      (NativeModules as Record<string, unknown>).SignalWireVoipPush = {
        getToken: jest.fn(async () => null),
        getPendingCalls: jest.fn(async () => [{ callId: 'x' }, null, { uuid: 'b' }])
      };
      await expect(getPendingVoipCalls()).resolves.toEqual([{ uuid: 'b' }]);
    });

    it('still reads a hook generated before calls were kept per call', async () => {
      // A bare app may carry a hand-copied hook with the single-slot methods.
      const clearPendingCall = jest.fn(async () => undefined);
      (NativeModules as Record<string, unknown>).SignalWireVoipPush = {
        getToken: jest.fn(async () => null),
        getPendingCall: jest.fn(async () => ({ uuid: 'only' })),
        clearPendingCall
      };
      await expect(getPendingVoipCalls()).resolves.toEqual([{ uuid: 'only' }]);
      await forgetPendingVoipCall('only');
      expect(clearPendingCall).toHaveBeenCalledTimes(1);
    });

    it('forgets one call by uuid, leaving the others', async () => {
      const forgetPendingCall = jest.fn(async () => undefined);
      (NativeModules as Record<string, unknown>).SignalWireVoipPush = {
        getToken: jest.fn(async () => null),
        getPendingCalls: jest.fn(async () => []),
        forgetPendingCall
      };
      await forgetPendingVoipCall('a');
      expect(forgetPendingCall).toHaveBeenCalledWith('a');
    });

    it('returns nothing on Android', async () => {
      (Platform as { OS: string }).OS = 'android';
      await expect(getPendingVoipCalls()).resolves.toEqual([]);
    });
  });
});
