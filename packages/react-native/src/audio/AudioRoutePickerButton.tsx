import React from 'react';
import { Platform, UIManager, requireNativeComponent } from 'react-native';

import { dropProcessGlobal, processGlobal } from '../platform/processGlobal';
import { hasIosAudioRoutes } from './nativeAudioRoutes';

import type { ColorValue, HostComponent, ViewProps } from 'react-native';

export interface AudioRoutePickerButtonProps extends ViewProps {
  /** The icon's colour. Default: the system tint. */
  tintColor?: ColorValue;
  /**
   * The icon's colour while AirPlay is active (AVKit's definition). A call
   * routed to a headset or car is not AirPlay, so it doesn't change then.
   */
  activeTintColor?: ColorValue;
}

const NAME = 'SWAudioRoutePicker';

/**
 * Kept process-wide, not in module scope: the audio entry ships as both
 * `dist/audio.mjs` and `dist/audio.js`, and an app can load both (its own
 * `import`, a dependency's `require`). React Native throws when a view is
 * registered twice under one name, so one process gets one registration (see
 * the CallKit bridge's note on duplicated bundles). `null` (not linked) is
 * kept too.
 */
const PICKER_GLOBAL = '__signalwireRNAudioRoutePicker';

/**
 * Whether {@link AudioRoutePickerButton} draws anything: iOS, with this
 * package's native code built into the app, and incall-manager with iOS
 * audio routes (the upstream change, or the patch in `docs/patches/`).
 * Released incall-manager (through 4.3.0) neither reports a route the picker
 * chose nor keeps it, so the button isn't shown there.
 */
export function isAudioRoutePickerAvailable(): boolean {
  return getNativeView() !== null;
}

function getNativeView(): HostComponent<AudioRoutePickerButtonProps> | null {
  if (Platform.OS !== 'ios' || !hasIosAudioRoutes()) {
    return null;
  }
  return processGlobal(PICKER_GLOBAL, () =>
    UIManager.hasViewManagerConfig(NAME) ? requireNativeComponent<AudioRoutePickerButtonProps>(NAME) : null
  );
}

/**
 * The system audio output button (`AVRoutePickerView`). Tapping it opens iOS's
 * own route menu, which lists the phone, the speaker and each connected headset
 * or car by name, and switches the call itself.
 *
 * Renders nothing on Android, on iOS without incall-manager's iOS routes, or
 * when the app was built before this version of the package (native code
 * needs a rebuild). Size it with `style`;
 * the default is 44 × 44, the minimum touch target. VoiceOver reads it as a
 * button with `accessibilityLabel` (default "Audio output").
 */
export function AudioRoutePickerButton({
  style,
  accessibilityLabel = 'Audio output',
  ...props
}: AudioRoutePickerButtonProps): React.JSX.Element | null {
  const Native = getNativeView();
  if (!Native) {
    return null;
  }
  return <Native accessibilityLabel={accessibilityLabel} style={[{ height: 44, width: 44 }, style]} {...props} />;
}

/** Test seam: look the native view up again. */
export function resetAudioRoutePickerForTesting(): void {
  dropProcessGlobal(PICKER_GLOBAL);
}
