import { NativeModules } from 'react-native';

import { MissingPeerDependencyError } from '../errors';

import type * as ReactNativeWebRTC from 'react-native-webrtc';

// Metro supplies `require` at runtime; this package's tsconfig has no Node types.
declare const require: (moduleName: string) => unknown;

/**
 * Loads `react-native-webrtc`, or throws {@link MissingPeerDependencyError}
 * when its native module is not linked.
 *
 * Required lazily, not imported. An installed but unlinked react-native-webrtc
 * (a dev client not rebuilt since it was added) throws while it is evaluated:
 * on the New Architecture the missing native module is `null`, its
 * `src/index.ts` throws "WebRTC native module not found", and on iOS its
 * EventEmitter's `new NativeEventEmitter(null)` fails an invariant first. A
 * static import therefore crashed the app's entry file before any guard ran.
 * Metro still resolves the literal specifier at bundle time; only evaluation
 * is deferred, to the first call or render that needs WebRTC.
 *
 * The check is the native module itself. The JS `mediaDevices` object always
 * has `getUserMedia`, so testing that could never fail.
 */
export function loadReactNativeWebRTC(feature: string): typeof ReactNativeWebRTC {
  const modules = NativeModules as Record<string, unknown> | undefined;
  if (modules && (modules.WebRTCModule === null || modules.WebRTCModule === undefined)) {
    throw new MissingPeerDependencyError('react-native-webrtc', feature);
  }
  return require('react-native-webrtc') as typeof ReactNativeWebRTC;
}
