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
 * needs a rebuild). Size it with `style`; the default is 44 × 44, the minimum
 * touch target. `style` applies to the view around the native picker (React
 * Native's New Architecture draws the background, border, radius, opacity,
 * transform and shadow there, once), and its padding insets the icon; a tap
 * anywhere in that view, padding, border and `hitSlop` included, opens the
 * menu. VoiceOver reads it as a button (`accessibilityRole`, default
 * `'button'`) with `accessibilityLabel` (default "Audio output"). `aria-*`
 * and `id` work as on `View`.
 */
export function AudioRoutePickerButton({
  style,
  accessibilityLabel = 'Audio output',
  accessibilityRole = 'button',
  ...props
}: AudioRoutePickerButtonProps): React.JSX.Element | null {
  const Native = getNativeView();
  if (!Native) {
    return null;
  }
  return (
    <Native
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole}
      style={[{ height: 44, width: 44 }, style]}
      {...hostProps(props)}
    />
  );
}

/**
 * View's own prop mapping, for the props React Native's `View` translates in
 * JS before they reach a native host: this component renders the host
 * directly, so without it `aria-label`, `aria-hidden`, `aria-disabled` and
 * `id` would be dropped. Mirrors React Native 0.81's View.js.
 */
function hostProps(props: Omit<AudioRoutePickerButtonProps, 'style'>): Omit<AudioRoutePickerButtonProps, 'style'> {
  const {
    'aria-busy': ariaBusy,
    'aria-checked': ariaChecked,
    'aria-disabled': ariaDisabled,
    'aria-expanded': ariaExpanded,
    'aria-hidden': ariaHidden,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    'aria-live': ariaLive,
    'aria-selected': ariaSelected,
    'aria-valuemax': ariaValueMax,
    'aria-valuemin': ariaValueMin,
    'aria-valuenow': ariaValueNow,
    'aria-valuetext': ariaValueText,
    id,
    tabIndex,
    ...rest
  } = props;
  const mapped: Omit<AudioRoutePickerButtonProps, 'style'> = { ...rest };
  if (ariaLabel !== undefined) {
    mapped.accessibilityLabel = ariaLabel;
  }
  const labelledBy = ariaLabelledBy?.split(/\s*,\s*/g);
  if (labelledBy !== undefined) {
    mapped.accessibilityLabelledBy = labelledBy;
  }
  if (ariaLive !== undefined) {
    mapped.accessibilityLiveRegion = ariaLive === 'off' ? 'none' : ariaLive;
  }
  if (ariaHidden !== undefined) {
    mapped.accessibilityElementsHidden = ariaHidden;
    if (ariaHidden) {
      mapped.importantForAccessibility = 'no-hide-descendants';
    }
  }
  if (id !== undefined) {
    mapped.nativeID = id;
  }
  if (tabIndex !== undefined) {
    mapped.focusable = !tabIndex;
  }
  const state = rest.accessibilityState;
  if (state != null || ariaBusy != null || ariaChecked != null || ariaDisabled != null || ariaExpanded != null || ariaSelected != null) {
    mapped.accessibilityState = {
      busy: ariaBusy ?? state?.busy,
      checked: ariaChecked ?? state?.checked,
      disabled: ariaDisabled ?? state?.disabled,
      expanded: ariaExpanded ?? state?.expanded,
      selected: ariaSelected ?? state?.selected
    };
  }
  const value = rest.accessibilityValue;
  if (value != null || ariaValueMax != null || ariaValueMin != null || ariaValueNow != null || ariaValueText != null) {
    mapped.accessibilityValue = {
      max: ariaValueMax ?? value?.max,
      min: ariaValueMin ?? value?.min,
      now: ariaValueNow ?? value?.now,
      text: ariaValueText ?? value?.text
    };
  }
  return mapped;
}

/** Test seam: look the native view up again. */
export function resetAudioRoutePickerForTesting(): void {
  dropProcessGlobal(PICKER_GLOBAL);
}
