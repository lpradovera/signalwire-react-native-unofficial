import { logger, useCall } from '@signalwire/react';
import { useAudioRoute } from '@signalwire/react-native/audio';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useSignalWireTheme } from '../theme/ThemeProvider';
import { ControlButton } from './ControlButton';

import type { Call } from '@signalwire/js';
import type { StyleProp, ViewStyle } from 'react-native';

export interface CallControlsProps {
  call: Call | null | undefined;
  /** Hide the camera toggle for audio-only calls. Default `true`. */
  showVideo?: boolean;
  /** Hide the speaker toggle. Default `true`. */
  showAudioRoute?: boolean;
  /** Called once the user has hung up, for navigating away. Always fires,
   * even when the SDK teardown fails — see the handler below. */
  onHangup?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * Mute, camera, speaker and hang up.
 *
 * Owns no state: everything comes from `useCall` and `useAudioRoute`, so the
 * bar always agrees with the SDK even when the change came from elsewhere —
 * the CallKit mute button, or the remote side.
 */
export function CallControls({
  call,
  showVideo = true,
  showAudioRoute = true,
  onHangup,
  style,
  testID
}: CallControlsProps): React.JSX.Element {
  const theme = useSignalWireTheme();
  const { isAudioMuted, isVideoMuted, setAudioMuted, setVideoMuted, hangup } = useCall(call);
  const { route, setRoute } = useAudioRoute();

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
          label={route === 'speaker' ? 'Speaker' : 'Earpiece'}
          active={route === 'speaker'}
          onPress={() => setRoute(route === 'speaker' ? 'earpiece' : 'speaker')}
        />
      ) : null}

      <ControlButton
        testID="sw-hangup"
        label="End"
        variant="danger"
        onPress={() => {
          // Leaving must not depend on the SDK teardown succeeding. A call the
          // far end never answered rejects here — the verto `bye` gets no
          // response and times out — and gating navigation on that stranded
          // the user on the call screen with no way back and no feedback.
          void hangup()
            .catch((error: unknown) => {
              logger.warn('Hangup failed; leaving the call screen anyway:', error);
            })
            .finally(() => onHangup?.());
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'center' }
});
