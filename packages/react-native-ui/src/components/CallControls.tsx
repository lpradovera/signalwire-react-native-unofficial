import { logger, useCall } from '@signalwire/react';
import {
  AudioRoutePickerButton,
  isAudioRoutePickerAvailable,
  useAudioRoute
} from '@signalwire/react-native/audio';
import React from 'react';
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
   * iOS, in an app built with this package's native code.
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
  const { isAudioMuted, isVideoMuted, setAudioMuted, setVideoMuted, hangup } = useCall(call);
  const { route, setSpeakerOn } = useAudioRoute();

  return (
    <View
      testID={testID}
      accessibilityRole="toolbar"
      style={[styles.bar, { gap: theme.spacing.sm, padding: theme.spacing.md }, style]}
    >
      <ControlButton
        testID="sw-mute"
        label={isAudioMuted ? 'Unmute' : 'Mute'}
        active={isAudioMuted}
        onPress={() => void setAudioMuted(!isAudioMuted)}
      />

      {showVideo ? (
        <ControlButton
          testID="sw-video"
          label={isVideoMuted ? 'Camera on' : 'Camera off'}
          active={isVideoMuted}
          onPress={() => void setVideoMuted(!isVideoMuted)}
        />
      ) : null}

      {showAudioRoute ? (
        <ControlButton
          testID="sw-route"
          label={ROUTE_LABELS[route]}
          active={route === 'speaker'}
          // Off returns to the call's own route (a headset or car, if one is
          // connected), not the receiver.
          onPress={() => setSpeakerOn(route !== 'speaker')}
        />
      ) : null}

      {showRoutePicker && isAudioRoutePickerAvailable() ? (
        <View
          style={[
            styles.picker,
            { backgroundColor: theme.colors.surface, borderRadius: theme.radii.pill, padding: theme.spacing.xs }
          ]}
        >
          <AudioRoutePickerButton
            testID="sw-route-picker"
            tintColor={theme.colors.text}
          />
        </View>
      ) : null}

      <ControlButton
        testID="sw-hangup"
        label="End"
        variant="danger"
        onPress={() => {
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
  bar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'center' },
  picker: { alignItems: 'center', justifyContent: 'center' }
});
