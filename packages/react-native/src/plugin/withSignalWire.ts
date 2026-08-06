import { withAndroidCallKit } from './withAndroidCallKit';
import { withIosCallKit } from './withIosCallKit';
import { withVoipPush } from './withVoipPush';

import type { ConfigPlugin } from '@expo/config-plugins';

export interface SignalWirePluginOptions {
  /** iOS `NSMicrophoneUsageDescription`. */
  microphonePermission?: string;
  /** iOS `NSCameraUsageDescription`. */
  cameraPermission?: string;
  /** Add ConnectionService / CallKit permissions. Default `true`. */
  enableCallKit?: boolean;
  /** Add the iOS `voip` background mode. Default `true`. */
  enableVoipPush?: boolean;
}

const DEFAULT_MIC = 'This app uses the microphone for calls.';
const DEFAULT_CAMERA = 'This app uses the camera for video calls.';

/**
 * Expo config plugin for `@signalwire/react-native`.
 *
 * ```json
 * { "plugins": [["@signalwire/react-native", { "enableVoipPush": true }]] }
 * ```
 *
 * With `enableVoipPush` it also generates the native PushKit hook, as a
 * separate Objective-C category rather than a patch to `AppDelegate.swift`.
 * Reporting a cold-start VoIP push to CallKit must happen in native code — the
 * JS bundle is not running yet and iOS kills an app that does not report the
 * call almost immediately — but regex-patching Expo's Swift template fails
 * silently when the template changes, and Swift cannot import RNCallKeep
 * (react-native-callkeep#856). A category avoids both problems and survives
 * `expo prebuild` regenerating the AppDelegate.
 */
const withSignalWire: ConfigPlugin<SignalWirePluginOptions | undefined> = (config, options) => {
  const {
    microphonePermission = DEFAULT_MIC,
    cameraPermission = DEFAULT_CAMERA,
    enableCallKit = true,
    enableVoipPush = true
  } = options ?? {};

  const withIos = withIosCallKit(config, {
    microphonePermission,
    cameraPermission,
    enableVoipPush
  });

  const withPush = enableVoipPush ? withVoipPush(withIos) : withIos;

  return withAndroidCallKit(withPush, { enableCallKit });
};

export default withSignalWire;
