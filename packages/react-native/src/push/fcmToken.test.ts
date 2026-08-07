/**
 * Firebase is an optional peer: an app with no Android push should not be made
 * to install the Firebase SDK, and its absence must be quiet rather than a
 * crash at import — the same contract as the other native peers.
 */
let mockPlatformOS = 'android';
jest.mock('react-native', () => ({
  get Platform() {
    return { OS: mockPlatformOS };
  }
}));

// Firebase ships untransformed ESM that jest will not parse, and this suite is
// about our wrapper, not theirs. Default to an empty namespace — which is also
// the "not installed" shape — and let individual tests substitute a working one.
jest.mock('@react-native-firebase/messaging', () => ({}), { virtual: true });

describe('getFcmToken', () => {
  beforeEach(() => {
    jest.resetModules();
    mockPlatformOS = 'android';
  });

  it('returns null on iOS, where PushKit owns push', async () => {
    mockPlatformOS = 'ios';
    const { getFcmToken } = require('./fcmToken') as typeof import('./fcmToken');
    await expect(getFcmToken()).resolves.toBeNull();
  });

  it('returns null when Firebase is not installed', async () => {
    // Absent module: the namespace has none of the functions we probe for.
    jest.doMock('@react-native-firebase/messaging', () => ({}), { virtual: true });
    const { getFcmToken } = require('./fcmToken') as typeof import('./fcmToken');
    await expect(getFcmToken()).resolves.toBeNull();
  });

  it('reads the token when Firebase is present', async () => {
    jest.doMock(
      '@react-native-firebase/messaging',
      () => ({
        getMessaging: () => ({}),
        getToken: async () => 'fcm-token-1',
        onTokenRefresh: () => () => undefined,
        requestPermission: async () => 1
      }),
      { virtual: true }
    );
    const { getFcmToken } = require('./fcmToken') as typeof import('./fcmToken');
    await expect(getFcmToken()).resolves.toBe('fcm-token-1');
  });

  it('survives a getToken that rejects', async () => {
    // No Play Services, no network, or a project misconfiguration. A thrown
    // error here would take down whatever registered the device.
    jest.doMock(
      '@react-native-firebase/messaging',
      () => ({
        getMessaging: () => ({}),
        getToken: async () => {
          throw new Error('SERVICE_NOT_AVAILABLE');
        },
        onTokenRefresh: () => () => undefined
      }),
      { virtual: true }
    );
    const { getFcmToken } = require('./fcmToken') as typeof import('./fcmToken');
    await expect(getFcmToken()).resolves.toBeNull();
  });
});

describe('watchPushToken', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('reports android tokens as android', async () => {
    mockPlatformOS = 'android';
    jest.doMock(
      '@react-native-firebase/messaging',
      () => ({
        getMessaging: () => ({}),
        getToken: async () => 'fcm-1',
        onTokenRefresh: () => () => undefined,
        requestPermission: async () => 1
      }),
      { virtual: true }
    );
    const { watchPushToken } = require('./pushToken') as typeof import('./pushToken');

    const seen: Array<{ platform: string; token: string }> = [];
    watchPushToken((registration) => seen.push(registration));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seen).toEqual([{ platform: 'android', token: 'fcm-1' }]);
  });
});
