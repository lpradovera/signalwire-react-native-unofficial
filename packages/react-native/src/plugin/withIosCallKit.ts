import { withInfoPlist } from '@expo/config-plugins';

import type { ConfigPlugin } from '@expo/config-plugins';

export interface IosOptions {
  microphonePermission: string;
  cameraPermission: string;
  enableVoipPush: boolean;
}

/** Adds the usage strings and background modes a calling app needs. */
export const withIosCallKit: ConfigPlugin<IosOptions> = (config, options) =>
  withInfoPlist(config, (plistConfig) => {
    const plist = plistConfig.modResults;

    plist.NSMicrophoneUsageDescription = options.microphonePermission;
    plist.NSCameraUsageDescription = options.cameraPermission;

    const modes = new Set<string>((plist.UIBackgroundModes as string[] | undefined) ?? []);
    modes.add('audio');
    if (options.enableVoipPush) {
      modes.add('voip');
    }
    plist.UIBackgroundModes = [...modes];

    return plistConfig;
  });
