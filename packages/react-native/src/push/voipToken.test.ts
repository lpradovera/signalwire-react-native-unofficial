import { NativeModules, Platform } from 'react-native';

import { getVoipToken, watchVoipToken } from './voipToken';

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
});
