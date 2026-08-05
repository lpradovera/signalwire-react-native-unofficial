import { withAndroidCallKit } from './withAndroidCallKit';
import { withIosCallKit } from './withIosCallKit';

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
 * It does not patch `AppDelegate` source: reporting a cold-start VoIP push to
 * CallKit must happen in native code, and Expo SDK 52's Swift AppDelegate makes
 * regex patching fragile. See `docs/native-setup.md` for that step.
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

  return withAndroidCallKit(withIos, { enableCallKit });
};

export default withSignalWire;
