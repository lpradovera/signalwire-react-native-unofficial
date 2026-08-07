import { withEntitlementsPlist, withInfoPlist } from '@expo/config-plugins';

import type { ConfigPlugin } from '@expo/config-plugins';

export interface IosOptions {
  microphonePermission: string;
  cameraPermission: string;
  enableVoipPush: boolean;
}

/**
 * Adds the usage strings, background modes and push entitlement a calling app
 * needs.
 *
 * The entitlement matters more than it looks: `expo prebuild` regenerates the
 * entitlements file, so a capability added by hand in Xcode disappears on the
 * next prebuild. Without `aps-environment` iOS issues no PushKit token at all,
 * and the failure is silent from the server's side — APNs keeps accepting
 * pushes and reporting them delivered while the device receives nothing.
 */
export const withIosCallKit: ConfigPlugin<IosOptions> = (config, options) => {
  const withPlist = withInfoPlistEntries(config, options);

  if (!options.enableVoipPush) {
    return withPlist;
  }

  return withEntitlementsPlist(withPlist, (entitlementsConfig) => {
    // `development` is correct for debug builds, which are signed against the
    // APNs sandbox. Release builds need `production`; Xcode rewrites this
    // during a distribution build, so it is not pinned here.
    entitlementsConfig.modResults['aps-environment'] ??= 'development';
    return entitlementsConfig;
  });
};

const withInfoPlistEntries: ConfigPlugin<IosOptions> = (config, options) =>
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
