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
let mockShape: 'as-installed' | 'named-only' | 'throws' | 'unbundled' = 'as-installed';
let mockOS = 'android';
const mockEvaluations: string[] = [];

jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  const { installRnfbNatives } = jest.requireActual('../../jest/rnfb');
  Object.defineProperty(RN.Platform, 'OS', { configurable: true, get: () => mockOS });
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
  if (mockShape === 'unbundled') {
    // The JavaScript is not in the bundle while the native module is linked:
    // what an app built from the ES-module build with esbuild's __require shim
    // got. Metro's runtime throws this from loadModuleImplementation.
    throw new Error('Requiring unknown module "@react-native-firebase/messaging".');
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
  mockOS = 'android';
  mockEvaluations.length = 0;
});

/** The logger of the module registry `load()` just created. */
function spyOnLogger(): Record<'debug' | 'info' | 'warn' | 'error', jest.SpyInstance> {
  const { logger } = require('@signalwire/react');
  return {
    debug: jest.spyOn(logger, 'debug').mockImplementation(() => undefined),
    info: jest.spyOn(logger, 'info').mockImplementation(() => undefined),
    warn: jest.spyOn(logger, 'warn').mockImplementation(() => undefined),
    error: jest.spyOn(logger, 'error').mockImplementation(() => undefined)
  };
}

describe('when Firebase is resolved', () => {
  // Metro reports a throw from a module that is loaded outside another
  // module's load as a fatal error, before the caller's catch runs: a release
  // build dies (seen on a Pixel 6 Pro, from watchPushToken's effect). Inside a
  // module's own evaluation the same throw reaches the catch. So Firebase is
  // required while this module is evaluated, and never from a later call.
  it('requires Firebase while this module is evaluated, never on a later call', () => {
    const { loadFirebaseMessaging } = load();
    expect(mockEvaluations).toEqual(['as-installed']);

    loadFirebaseMessaging();
    loadFirebaseMessaging();
    expect(mockEvaluations).toEqual(['as-installed']);
  });

  it('contains a throw from Firebase during this module\'s evaluation', () => {
    mockShape = 'throws';
    let loaded: typeof import('./firebaseMessaging') | undefined;
    expect(() => {
      loaded = load();
    }).not.toThrow();
    expect(mockEvaluations).toEqual(['throws']);
    expect(loaded?.loadFirebaseMessaging()).toBeUndefined();
    expect(mockEvaluations).toEqual(['throws']);
  });

  it('turns push off when the JavaScript was not bundled but the native module is linked', () => {
    mockShape = 'unbundled';
    const { loadFirebaseMessaging } = load();
    expect(mockEvaluations).toEqual(['unbundled']);
    expect(loadFirebaseMessaging()).toBeUndefined();
  });

  it('does not touch Firebase on iOS, where PushKit owns push', () => {
    mockOS = 'ios';
    const { loadFirebaseMessaging } = load();
    const log = spyOnLogger();
    expect(loadFirebaseMessaging()).toBeUndefined();
    expect(mockEvaluations).toEqual([]);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('reporting that push is off', () => {
  it.each([
    ['not linked', () => (mockNative.linked = false)],
    ['linked without a google-services.json', () => (mockNative.constantsThrow = true)]
    // A warning, not info: the SDK logger's default level is warn, so an info
    // line never shows in a release build, and "why is push off" is exactly
    // what a release build's tester needs to see.
  ])('says so once, in one warning, when Firebase is %s', (_case, arrange) => {
    arrange();
    const { loadFirebaseMessaging } = load();
    const log = spyOnLogger();

    // registerAndroidCallPush, getFcmToken and watchFcmToken each ask.
    loadFirebaseMessaging();
    loadFirebaseMessaging();
    loadFirebaseMessaging();

    expect(log.info).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    const line = log.warn.mock.calls[0].join(' ');
    expect(line).toMatch(/Android push is off/);
    // Not the Java stack the native module's getConstants() throws with.
    expect(line).not.toMatch(/\n/);
  });

  it('warns once when Firebase is linked but fails to load', () => {
    mockShape = 'unbundled';
    const { loadFirebaseMessaging } = load();
    const log = spyOnLogger();
    loadFirebaseMessaging();
    loadFirebaseMessaging();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0].join(' ')).toMatch(/Requiring unknown module/);
  });
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
