/**
 * FCM tokens, against the real RNFB 22.4.0 JavaScript with its native side
 * stubbed (`jest/rnfb.ts`).
 *
 * Firebase is an optional peer: an app with no Android push should not be made
 * to install the Firebase SDK, and its absence must be quiet rather than a
 * crash at import — the same contract as the other native peers.
 */
import type { RnfbNativeState } from '../../jest/rnfb';

const mockNative: RnfbNativeState & { linked: boolean } = { apps: [], calls: [], linked: true };
let mockPlatform = { OS: 'android', Version: 34 };
let mockPermission: 'granted' | 'denied' = 'granted';
const mockPermissionRequests: string[] = [];

jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  const { installRnfbNatives } = jest.requireActual('../../jest/rnfb');
  Object.defineProperty(RN.Platform, 'OS', { configurable: true, get: () => mockPlatform.OS });
  Object.defineProperty(RN.Platform, 'Version', {
    configurable: true,
    get: () => mockPlatform.Version
  });
  if (mockNative.linked) {
    installRnfbNatives(RN.NativeModules, mockNative);
  } else {
    delete RN.NativeModules.RNFBAppModule;
    delete RN.NativeModules.RNFBMessagingModule;
  }
  RN.PermissionsAndroid.request = async (permission: string) => {
    mockPermissionRequests.push(permission);
    return mockPermission;
  };
  return RN;
});


function load<T>(path: string): T {
  jest.resetModules();
  return require(path) as T;
}

beforeEach(() => {
  mockNative.apps = [require('../../jest/rnfb').DEFAULT_FIREBASE_APP];
  mockNative.calls = [];
  mockNative.linked = true;
  mockPlatform = { OS: 'android', Version: 34 };
  mockPermission = 'granted';
  mockPermissionRequests.length = 0;
});

describe('getFcmToken', () => {
  it('returns null on iOS, where PushKit owns push', async () => {
    mockPlatform = { OS: 'ios', Version: 18 };
    const { getFcmToken } = load<typeof import('./fcmToken')>('./fcmToken');
    await expect(getFcmToken()).resolves.toBeNull();
    expect(mockNative.calls).toEqual([]);
  });

  it('returns null when Firebase is not linked', async () => {
    mockNative.linked = false;
    const { getFcmToken } = load<typeof import('./fcmToken')>('./fcmToken');
    await expect(getFcmToken()).resolves.toBeNull();
  });

  it('reads the token from RNFB 22.x as installed', async () => {
    const { getFcmToken } = load<typeof import('./fcmToken')>('./fcmToken');
    await expect(getFcmToken()).resolves.toBe('fcm-token');
    expect(mockNative.calls).toContain('getToken');
  });

  it('asks for POST_NOTIFICATIONS on Android 13 and later', async () => {
    // RNFB's requestPermission resolves at once on Android without asking
    // anything, so without this the incoming-call notification can never show.
    const { getFcmToken } = load<typeof import('./fcmToken')>('./fcmToken');
    await getFcmToken();
    expect(mockPermissionRequests).toEqual(['android.permission.POST_NOTIFICATIONS']);
  });

  it('does not ask on Android 12, where notifications need no runtime grant', async () => {
    mockPlatform = { OS: 'android', Version: 32 };
    const { getFcmToken } = load<typeof import('./fcmToken')>('./fcmToken');
    await expect(getFcmToken()).resolves.toBe('fcm-token');
    expect(mockPermissionRequests).toEqual([]);
  });

  it('still returns the token when the user declines notifications', async () => {
    // A call push is a data message: it still arrives and wakes the app.
    mockPermission = 'denied';
    const { getFcmToken } = load<typeof import('./fcmToken')>('./fcmToken');
    await expect(getFcmToken()).resolves.toBe('fcm-token');
  });

  it('returns null on a build with no google-services.json', async () => {
    mockNative.apps = [];
    const { getFcmToken } = load<typeof import('./fcmToken')>('./fcmToken');
    await expect(getFcmToken()).resolves.toBeNull();
  });
});

describe('watchFcmToken', () => {
  it('does not throw on a build with no google-services.json', () => {
    // It runs in a React effect (useDeviceRegistration): a throw there takes
    // the screen down.
    mockNative.apps = [];
    const { watchFcmToken } = load<typeof import('./fcmToken')>('./fcmToken');
    let unsubscribe: (() => void) | undefined;
    expect(() => {
      unsubscribe = watchFcmToken(() => undefined);
    }).not.toThrow();
    expect(() => unsubscribe?.()).not.toThrow();
  });

  it('calls back with the current token', async () => {
    const { watchFcmToken } = load<typeof import('./fcmToken')>('./fcmToken');
    const seen: string[] = [];
    const unsubscribe = watchFcmToken((token) => seen.push(token));
    await new Promise((resolve) => setTimeout(resolve, 0));
    unsubscribe();
    expect(seen).toEqual(['fcm-token']);
  });
});

describe('watchPushToken', () => {
  it('reports android tokens as android', async () => {
    const { watchPushToken } = load<typeof import('./pushToken')>('./pushToken');

    const seen: Array<{ platform: string; token: string }> = [];
    const unsubscribe = watchPushToken((registration) => seen.push(registration));
    await new Promise((resolve) => setTimeout(resolve, 0));
    unsubscribe();

    expect(seen).toEqual([{ platform: 'android', token: 'fcm-token' }]);
  });
});
