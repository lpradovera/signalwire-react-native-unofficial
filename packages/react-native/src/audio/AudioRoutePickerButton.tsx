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

let nativeView: HostComponent<AudioRoutePickerButtonProps> | null | undefined;

/**
 * Whether {@link AudioRoutePickerButton} draws anything: iOS, with this
 * package's native code built into the app.
 */
export function isAudioRoutePickerAvailable(): boolean {
  return getNativeView() !== null;
}

function getNativeView(): HostComponent<AudioRoutePickerButtonProps> | null {
  if (nativeView !== undefined) {
    return nativeView;
  }
  const linked =
    Platform.OS === 'ios' &&
    (UIManager.hasViewManagerConfig?.(NAME) ?? Boolean(UIManager.getViewManagerConfig?.(NAME)));
  nativeView = linked ? requireNativeComponent<AudioRoutePickerButtonProps>(NAME) : null;
  return nativeView;
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
  nativeView = undefined;
}
