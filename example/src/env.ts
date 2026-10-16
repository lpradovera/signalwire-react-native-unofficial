/**
 * Chooses between a value and its Android-only override.
 *
 * An empty string counts as unset. Expo drops a blank `KEY=` line in `.env`,
 * but a variable exported empty from the shell reaches the bundle as '' — the
 * natural way to drop the emulator override for one run on a physical device
 * (`EXPO_PUBLIC_SW_TOKEN_URL_ANDROID= npx expo run:android`). With `??` that ''
 * won over the base value and silently switched the feature off.
 */
export function pickForPlatform(
  os: string,
  base: string | undefined,
  android: string | undefined
): string | undefined {
  return (os === 'android' ? android : undefined) || base || undefined;
}
