/**
 * The Firebase messaging loader, against the real RNFB 22.4.0 JavaScript.
 *
 * See `jest/rnfb.ts`: flat mocks of named functions were the one shape the old
 * loader accepted, so they hid that it rejected RNFB 22.x as installed.
 */
import type { RnfbNativeState } from '../../jest/rnfb';

const mockNative: RnfbNativeState & { linked: boolean; constantsThrow: boolean } = {
  apps: [],
  calls: [],
  linked: true,
  constantsThrow: false
};
let mockShape: 'as-installed' | 'named-only' | 'throws' = 'as-installed';
const mockEvaluations: string[] = [];

jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  const { installRnfbNatives } = jest.requireActual('../../jest/rnfb');
  Object.defineProperty(RN.Platform, 'OS', { configurable: true, get: () => 'android' });
  Object.defineProperty(RN.Platform, 'Version', { configurable: true, get: () => 34 });
  if (mockNative.constantsThrow) {
    // A build that links Firebase without a google-services.json: reading the
    // module runs its getConstants(), which calls FirebaseMessaging.getInstance().
    installRnfbNatives(RN.NativeModules, mockNative);
    Object.defineProperty(RN.NativeModules, 'RNFBMessagingModule', {
      configurable: true,
      get: () => {
        throw new Error(
          "Exception in HostObject::get for prop 'RNFBMessagingModule': java.lang.IllegalStateException: Default FirebaseApp is not initialized in this process"
        );
      }
    });
  } else if (mockNative.linked) {
    installRnfbNatives(RN.NativeModules, mockNative);
  } else {
    delete RN.NativeModules.RNFBAppModule;
    delete RN.NativeModules.RNFBMessagingModule;
  }
  return RN;
});

jest.mock('@react-native-firebase/messaging', () => {
  mockEvaluations.push(mockShape);
  if (mockShape === 'throws') {
    throw new Error('Native module RNFBAppModule not found.');
  }
  const real = jest.requireActual('@react-native-firebase/messaging');
  if (mockShape === 'named-only') {
    // A Firebase release without the namespaced default export.
    const named = { ...real };
    delete named.default;
    return named;
  }
  return real;
});

function load(): typeof import('./firebaseMessaging') {
  jest.resetModules();
  return require('./firebaseMessaging');
}

beforeEach(() => {
  mockNative.apps = [];
  mockNative.calls = [];
  mockNative.linked = true;
  mockNative.constantsThrow = false;
  mockShape = 'as-installed';
  mockEvaluations.length = 0;
});

describe('loadFirebaseMessaging', () => {
  it('uses RNFB 22.x as installed, whose default export is the namespaced messaging()', () => {
    const real = jest.requireActual('@react-native-firebase/messaging');
    // The trap: `default` is truthy and has none of the modular functions.
    expect(typeof real.default).toBe('function');
    expect(real.default.getMessaging).toBeUndefined();

    const messaging = load().loadFirebaseMessaging();

    // The module's own modular functions (a fresh registry, so compared by name).
    expect(messaging?.getMessaging.name).toBe('getMessaging');
    expect(messaging?.onMessage.name).toBe('onMessage');
    expect(messaging?.setBackgroundMessageHandler.name).toBe('setBackgroundMessageHandler');
    expect(messaging?.getToken.name).toBe('getToken');
    expect(messaging?.onTokenRefresh.name).toBe('onTokenRefresh');
  });

  it('uses a release with named exports only', () => {
    mockShape = 'named-only';
    const messaging = load().loadFirebaseMessaging();
    expect(typeof messaging?.getMessaging).toBe('function');
  });

  it('does not evaluate Firebase when its native module is not linked', () => {
    // Evaluating RNFB without RNFBAppModule throws, and a throw while Metro
    // loads a module outside another module's load is reported as fatal: a
    // crash in a release build. Checking for the native module first means
    // the JavaScript is never run on such a build.
    mockNative.linked = false;
    const messaging = load().loadFirebaseMessaging();
    expect(messaging).toBeUndefined();
    expect(mockEvaluations).toEqual([]);
  });

  it('survives a native module that throws when read (no google-services.json)', () => {
    // Seen on the emulator: the throw escaped registerAndroidCallPush() in the
    // entry file, so "main" was never registered and the app died at launch.
    mockNative.constantsThrow = true;
    const { loadFirebaseMessaging } = load();
    expect(() => loadFirebaseMessaging()).not.toThrow();
    expect(loadFirebaseMessaging()).toBeUndefined();
    expect(mockEvaluations).toEqual([]);
  });

  it('returns undefined when Firebase throws while loading', () => {
    mockShape = 'throws';
    const { loadFirebaseMessaging } = load();
    expect(() => loadFirebaseMessaging()).not.toThrow();
    expect(loadFirebaseMessaging()).toBeUndefined();
  });
});
