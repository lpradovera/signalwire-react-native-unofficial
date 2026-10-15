import React from 'react';
import { Platform, UIManager, requireNativeComponent } from 'react-native';

import type { ColorValue, HostComponent, ViewProps } from 'react-native';

export interface AudioRoutePickerButtonProps extends ViewProps {
  /** The icon's colour. Default: the system tint. */
  tintColor?: ColorValue;
  /** The icon's colour while audio plays through something other than the phone. */
  activeTintColor?: ColorValue;
}

const NAME = 'SWAudioRoutePicker';

/**
 * Kept on `globalThis`, not in module scope: the audio entry ships as both
 * `dist/audio.mjs` and `dist/audio.js`, and an app can load both (its own
 * `import`, a dependency's `require`). React Native throws when a view is
 * registered twice under one name, so one process gets one registration (see
 * the CallKit bridge's note on duplicated bundles).
 */
const PICKER_GLOBAL = '__signalwireRNAudioRoutePicker';

type PickerHolder = { [PICKER_GLOBAL]?: HostComponent<AudioRoutePickerButtonProps> | null };

/**
 * Whether {@link AudioRoutePickerButton} draws anything: iOS, with this
 * package's native code built into the app.
 */
export function isAudioRoutePickerAvailable(): boolean {
  return getNativeView() !== null;
}

function getNativeView(): HostComponent<AudioRoutePickerButtonProps> | null {
  if (Platform.OS !== 'ios') {
    return null;
  }
  const holder = globalThis as PickerHolder;
  if (holder[PICKER_GLOBAL] === undefined) {
    const linked = UIManager.hasViewManagerConfig?.(NAME) ?? Boolean(UIManager.getViewManagerConfig?.(NAME));
    holder[PICKER_GLOBAL] = linked ? requireNativeComponent<AudioRoutePickerButtonProps>(NAME) : null;
  }
  return holder[PICKER_GLOBAL];
}

/**
 * The system audio output button (`AVRoutePickerView`). Tapping it opens iOS's
 * own route menu, which lists the phone, the speaker and each connected headset
 * or car by name, and switches the call itself.
 *
 * Renders nothing on Android, or on iOS when the app was built before this
 * version of the package (native code needs a rebuild). Size it with `style`;
 * the default is 44 × 44, the minimum touch target.
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
  delete (globalThis as PickerHolder)[PICKER_GLOBAL];
}
