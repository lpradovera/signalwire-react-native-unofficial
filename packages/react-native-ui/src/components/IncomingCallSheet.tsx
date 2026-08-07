import { useIncomingCalls } from '@signalwire/react';
import { useRingingPushes } from '@signalwire/react-native/ringing';
import React from 'react';
import { Modal, Platform, StyleSheet, Text, View } from 'react-native';

import { useSignalWireTheme } from '../theme/ThemeProvider';
import { ControlButton } from './ControlButton';

import type { Call, MediaOptions } from '@signalwire/js';

export interface IncomingCallSheetProps {
  /**
   * Media to answer with when the answer is NOT routed through the native call
   * UI. Defaults to audio only: an SDP answer cannot introduce an m-line the
   * offer lacks, so answering with video against an audio-only offer fails.
   */
  answerWith?: MediaOptions;
  onAnswered?: (call: Call) => void;
  onRejected?: (call: Call) => void;
  /**
   * Also draw calls that are ringing natively but have no SDK call yet.
   *
   * Defaults to true on Android and false on iOS, which is where the two
   * platforms genuinely differ: CallKit draws its own screen — on the lock
   * screen, over other apps — so a second sheet behind it is confusing.
   * Android's ConnectionService is registered self-managed and draws nothing
   * at all, so without this a pushed call is invisible until it times out.
   *
   * Set it explicitly if you run iOS without native call UI.
   */
  includeNativePushes?: boolean;
  testID?: string;
}

/**
 * In-app inbound call sheet.
 *
 * With CallKit enabled the native screen usually gets there first; this covers
 * the foreground case and apps running without native call UI. Renders nothing
 * when no call is pending, so it is safe to mount permanently.
 */
export function IncomingCallSheet({
  answerWith = { audio: true, video: false },
  onAnswered,
  onRejected,
  includeNativePushes = Platform.OS === 'android',
  testID
}: IncomingCallSheetProps): React.JSX.Element | null {
  const theme = useSignalWireTheme();
  const { calls, answer, reject } = useIncomingCalls();
  const { ringing, answer: answerPush, reject: rejectPush } = useRingingPushes();
  const call = calls[0];
  // The SDK call wins when both exist: they are the same call once it has
  // fused, and the SDK object is the one that can actually be answered.
  const push = call ? undefined : includeNativePushes ? ringing[0] : undefined;

  if (!call && !push) {
    return null;
  }

  const callerName = call
    ? (call.fromName ?? call.from ?? 'Unknown caller')
    : (push?.fromName ?? push?.from ?? 'Unknown caller');

  return (
    <Modal transparent animationType="slide" visible testID={testID}>
      <View style={[styles.backdrop, { backgroundColor: theme.colors.scrim }]}>
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: theme.colors.background,
              borderTopLeftRadius: theme.radii.md * 2,
              borderTopRightRadius: theme.radii.md * 2,
              gap: theme.spacing.sm,
              padding: theme.spacing.xl
            }
          ]}
        >
          <Text style={{ color: theme.colors.textMuted, fontSize: theme.typography.label }}>
            Incoming call
          </Text>
          <Text
            accessibilityRole="header"
            style={{ color: theme.colors.text, fontSize: theme.typography.title, fontWeight: '700' }}
          >
            {callerName}
          </Text>

          <View style={[styles.actions, { gap: theme.spacing.md, marginTop: theme.spacing.lg }]}>
            <ControlButton
              testID="sw-decline"
              label="Decline"
              variant="danger"
              style={styles.action}
              onPress={() => {
                if (call) {
                  void reject(call).then(() => onRejected?.(call));
                } else if (push) {
                  rejectPush(push.uuid);
                }
              }}
            />
            <ControlButton
              testID="sw-answer"
              label="Answer"
              variant="accent"
              style={styles.action}
              onPress={() => {
                if (call) {
                  void answer(call, answerWith).then(() => onAnswered?.(call));
                } else if (push) {
                  // The same intent a native answer applies, so both paths
                  // converge and whatever places the call picks it up.
                  answerPush(push.uuid);
                }
              }}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: {},
  actions: { flexDirection: 'row' },
  action: { flex: 1 }
});
