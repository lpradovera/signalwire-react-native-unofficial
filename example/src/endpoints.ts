import { Platform } from 'react-native';

/**
 * Where the app reaches the support server.
 *
 * Android gets its own overrides because the emulator does not inherit
 * MagicDNS: a tailnet hostname that resolves fine on the Mac fails on the
 * device with "Network request failed". `adb reverse tcp:3000 tcp:3000` maps
 * the host's port onto the emulator's localhost, which is stable across
 * reboots and network changes.
 *
 * iOS keeps the tailnet hostname — a physical device is not on the emulator's
 * loopback, and that path works.
 */
function pick(base: string | undefined, android: string | undefined): string | undefined {
  return (Platform.OS === 'android' ? android : undefined) ?? base;
}

export const TOKEN_URL = pick(
  process.env.EXPO_PUBLIC_SW_TOKEN_URL,
  process.env.EXPO_PUBLIC_SW_TOKEN_URL_ANDROID
);

export const DEVICES_URL = pick(
  process.env.EXPO_PUBLIC_SW_DEVICES_URL,
  process.env.EXPO_PUBLIC_SW_DEVICES_URL_ANDROID
);
