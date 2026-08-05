import { useIncomingCalls } from '@signalwire/react';
import React from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';

import { useSignalWireTheme } from '../theme/ThemeProvider';
import { ControlButton } from './ControlButton';

import type { Call, MediaOptions } from '@signalwire/js';

export interface IncomingCallSheetProps {
  /** Media to answer with. Defaults to audio and video. */
  answerWith?: MediaOptions;
  onAnswered?: (call: Call) => void;
  onRejected?: (call: Call) => void;
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
  answerWith = { audio: true, video: true },
  onAnswered,
  onRejected,
  testID
}: IncomingCallSheetProps): React.JSX.Element | null {
  const theme = useSignalWireTheme();
  const { calls, answer, reject } = useIncomingCalls();
  const call = calls[0];

  if (!call) {
    return null;
  }

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
            {call.fromName ?? call.from ?? 'Unknown caller'}
          </Text>

          <View style={[styles.actions, { gap: theme.spacing.md, marginTop: theme.spacing.lg }]}>
            <ControlButton
              testID="sw-decline"
              label="Decline"
              variant="danger"
              style={styles.action}
              onPress={() => {
                void reject(call).then(() => onRejected?.(call));
              }}
            />
            <ControlButton
              testID="sw-answer"
              label="Answer"
              variant="accent"
              style={styles.action}
              onPress={() => {
                void answer(call, answerWith).then(() => onAnswered?.(call));
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
