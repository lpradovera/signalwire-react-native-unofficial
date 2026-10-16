/**
 * A build whose Firebase JS is present but whose native module is not.
 *
 * This is what the example's iOS build is (Firebase is off iOS autolinking),
 * and what an Android build is when Firebase was installed but never linked:
 * `@react-native-firebase/messaging` is resolvable and bundled, but evaluating
 * it *throws* rather than exporting undefined members.
 *
 * A static import at the top of `androidCallPush` ran that at entry-file load,
 * so the app died before `registerRootComponent` and showed
 * `"main" has not been registered` with no working call path at all. Catching
 * the throw is not enough on Android either: Metro reports a throw from a
 * module loaded outside another module's load (a React effect calling
 * `watchPushToken`) as fatal, which ends a release build. So the JavaScript
 * must not be evaluated at all on such a build.
 */
let mockOS = 'ios';
const mockEvaluations: number[] = [];

jest.mock('react-native', () => ({
  get Platform() {
    return { OS: mockOS, Version: 34 };
  },
  // No RNFBAppModule / RNFBMessagingModule: Firebase is not linked.
  NativeModules: {},
  PermissionsAndroid: { request: async () => 'granted' }
}));
jest.mock(
  '@react-native-firebase/messaging',
  () => {
    mockEvaluations.push(1);
    throw new Error('Native module RNFBAppModule not found.');
  },
  { virtual: true }
);

import { registerAndroidCallPush } from './androidCallPush';
import { getFcmToken, watchFcmToken } from './fcmToken';

beforeEach(() => {
  mockEvaluations.length = 0;
});

describe.each(['ios', 'android'])('a %s build without the Firebase native module', (os) => {
  beforeEach(() => {
    mockOS = os;
  });

  it('registers call push without throwing, so the entry file survives', () => {
    // The assertion is the absence of a throw: everything after this call in
    // the app's entry file — `registerRootComponent` above all — depends on it.
    expect(() => registerAndroidCallPush()).not.toThrow();
  });

  it('reports no FCM token rather than crashing', async () => {
    await expect(getFcmToken()).resolves.toBeNull();
    expect(() => watchFcmToken(() => undefined)()).not.toThrow();
  });

  it('never evaluates the Firebase JavaScript', async () => {
    registerAndroidCallPush();
    await getFcmToken();
    watchFcmToken(() => undefined)();
    expect(mockEvaluations).toEqual([]);
  });
});
