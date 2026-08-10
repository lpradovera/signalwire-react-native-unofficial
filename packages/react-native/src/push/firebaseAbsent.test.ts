/**
 * A build whose Firebase JS is present but whose native module is not.
 *
 * This is what an iOS prebuild is: the plugin is conditional, so the app ships
 * without `RNFBAppModule`, while `@react-native-firebase/messaging` is still
 * resolvable from node_modules. Requiring it then *throws* rather than
 * exporting undefined members — the one failure mode a use-site guard cannot
 * catch, because the throw happens while the module is being evaluated.
 *
 * A static import at the top of `androidCallPush` ran that at entry-file load,
 * so the app died before `registerRootComponent` and iOS showed
 * `"main" has not been registered` with no working call path at all.
 */
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock(
  '@react-native-firebase/messaging',
  () => {
    throw new Error('Native module RNFBAppModule not found.');
  },
  { virtual: true }
);

import { registerAndroidCallPush } from './androidCallPush';
import { getFcmToken } from './fcmToken';

describe('a build without the Firebase native module', () => {
  it('registers call push without throwing, so the entry file survives', () => {
    // The assertion is the absence of a throw: everything after this call in
    // the app's entry file — `registerRootComponent` above all — depends on it.
    expect(() => registerAndroidCallPush()).not.toThrow();
  });

  it('reports no FCM token rather than crashing', async () => {
    await expect(getFcmToken()).resolves.toBeNull();
  });
});
