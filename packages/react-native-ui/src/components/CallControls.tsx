import { logger, useCall } from '@signalwire/react';
import { AudioRoutePickerButton, useAudioRoute } from '@signalwire/react-native/audio';
import React, { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useSignalWireTheme } from '../theme/ThemeProvider';
import { ControlButton } from './ControlButton';

import type { Call } from '@signalwire/js';
import type { AudioRoute } from '@signalwire/react-native/audio';
import type { StyleProp, ViewStyle } from 'react-native';

export interface CallControlsProps {
  call: Call | null | undefined;
  /** Hide the camera toggle for audio-only calls. Default `true`. */
  showVideo?: boolean;
  /** Hide the speaker toggle. Default `true`. */
  showAudioRoute?: boolean;
  /**
   * Show the system audio output button, iOS's own menu of the phone, the
   * speaker and each connected headset or car. Default: `showAudioRoute`, so
   * an app that hides audio routing doesn't get it either. It appears only on
   * iOS, in an app built with this package's native code, and with
   * react-native-incall-manager's iOS audio routes (the upstream change, or
   * the patch in `@signalwire/react-native`'s repository, `docs/patches/`);
   * released incall-manager through 4.3.0 shows nothing.
   */
  showRoutePicker?: boolean;
  /** Called once the user has hung up, for navigating away. Always fires,
   * even when the SDK teardown fails — see the handler below. */
  onHangup?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * Mute, camera, speaker, audio output (iOS) and hang up.
 *
 * Owns no state: everything comes from `useCall` and `useAudioRoute`, so the
 * bar always agrees with the SDK even when the change came from elsewhere —
 * the CallKit mute button, or the remote side.
 */
export function CallControls({
  call,
  showVideo = true,
  showAudioRoute = true,
  showRoutePicker = showAudioRoute,
  onHangup,
  style,
  testID
}: CallControlsProps): React.JSX.Element {
  const theme = useSignalWireTheme();
  const { self, isAudioMuted, isVideoMuted, setAudioMuted, setVideoMuted, hangup } = useCall(call);
  const { route, setSpeakerOn } = useAudioRoute();
  // The call End was pressed for. A ref, so a second tap handled before the
  // re-render is still ignored; the state disables the button.
  const endedRef = useRef<Call | null | undefined>(undefined);
  const [endedCall, setEndedCall] = useState<Call | null | undefined>(undefined);
  // Mute and camera act on the call's self participant, which exists only once
  // the call has joined; before that a tap could do nothing.
  const noSelf = !self;

  return (
    <View
      testID={testID}
      accessibilityRole="toolbar"
      style={[styles.bar, { columnGap: theme.spacing.sm, rowGap: theme.spacing.sm, padding: theme.spacing.md }, style]}
    >
      <ControlButton
        testID="sw-mute"
        label={isAudioMuted ? 'Unmute' : 'Mute'}
        accessibilityLabel="Mute"
        active={isAudioMuted}
        disabled={noSelf}
        onPress={() => {
          setAudioMuted(!isAudioMuted).catch((error: unknown) => {
            logger.warn('Changing the microphone mute failed:', error);
          });
        }}
      />

      {showVideo ? (
        <ControlButton
          testID="sw-video"
          label={isVideoMuted ? 'Camera on' : 'Camera off'}
          accessibilityLabel="Camera off"
          active={isVideoMuted}
          disabled={noSelf}
          onPress={() => {
            setVideoMuted(!isVideoMuted).catch((error: unknown) => {
              logger.warn('Changing the camera mute failed:', error);
            });
          }}
        />
      ) : null}

      {showAudioRoute ? (
        <ControlButton
          testID="sw-route"
          label={ROUTE_LABELS[route]}
          // The text shows the route the call is on; the control turns the
          // speaker on and off, so that is its name and `active` its state.
          accessibilityLabel="Speaker"
          active={route === 'speaker'}
          // Off returns to the call's own route (a headset or car, if one is
          // connected), not the receiver.
          onPress={() => setSpeakerOn(route !== 'speaker')}
        />
      ) : null}

      {showRoutePicker ? (
        // Renders nothing off iOS, without the native view, or without
        // incall-manager's iOS routes. The pill style sits on the button: on
        // the New Architecture React Native's interop container paints the
        // background and radius and insets the native view by the padding.
        <AudioRoutePickerButton
          testID="sw-route-picker"
          tintColor={theme.colors.text}
          style={{ backgroundColor: theme.colors.surface, borderRadius: theme.radii.pill, padding: theme.spacing.xs }}
        />
      ) : null}

      <ControlButton
        testID="sw-hangup"
        label="End"
        variant="danger"
        disabled={endedCall === call && endedRef.current === call}
        onPress={() => {
          // Once per call: a double tap would run onHangup twice (two
          // goBack()s pop the screen below too) and send a second bye.
          if (endedRef.current === call) {
            return;
          }
          endedRef.current = call;
          setEndedCall(call);
          // Leave first, tear down after. Gating navigation on `hangup()`
          // stranded the user on the call screen whenever the SDK did not
          // settle: a call the far end never answered rejects on an RPC
          // timeout, and one whose media never arrived may not settle at all,
          // so even a `.finally()` never runs. Ending a call is the one action
          // that must not wait on the network.
          onHangup?.();
          void hangup().catch((error: unknown) => {
            logger.warn('Hangup failed after leaving the call screen:', error);
          });
        }}
      />
    </View>
  );
}

/** The speaker toggle names the route the call is on. */
const ROUTE_LABELS: Record<AudioRoute, string> = {
  speaker: 'Speaker',
  earpiece: 'Earpiece',
  headset: 'Headset',
  bluetooth: 'Bluetooth'
};

const styles = StyleSheet.create({
  // Wraps: with the output button the row needs about 410 pt at the default
  // text size, more than most iPhones, and children don't shrink, so one row
  // would push Mute and End off both edges (more so at large Dynamic Type).
  bar: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' }
});
