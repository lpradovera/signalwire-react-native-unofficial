import { useCall } from '@signalwire/react';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useSignalWireTheme } from '../theme/ThemeProvider';

import type { Call, CallStatus as SdkCallStatus } from '@signalwire/js';
import type { StyleProp, ViewStyle } from 'react-native';

const LABELS: Partial<Record<SdkCallStatus, string>> = {
  new: 'Starting',
  trying: 'Connecting',
  ringing: 'Ringing',
  connecting: 'Connecting',
  connected: 'Connected',
  recovering: 'Reconnecting',
  disconnecting: 'Ending',
  disconnected: 'Ended',
  failed: 'Failed',
  destroyed: 'Ended'
};

export interface CallStatusProps {
  call: Call | null | undefined;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * A status pill.
 *
 * Shows the call error when there is one — a `recovering` badge is misleading
 * if media has already failed underneath it.
 */
export function CallStatus({ call, style, testID }: CallStatusProps): React.JSX.Element {
  const theme = useSignalWireTheme();
  const { status, error } = useCall(call);

  const label = error ? `${error.kind} error` : (LABELS[status] ?? status);
  const tone = error
    ? theme.colors.danger
    : status === 'connected'
      ? theme.colors.success
      : theme.colors.textMuted;

  return (
    <View
      testID={testID}
      accessibilityRole="text"
      accessibilityLabel={`Call status: ${label}`}
      style={[
        styles.pill,
        {
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radii.pill,
          paddingHorizontal: theme.spacing.md,
          paddingVertical: theme.spacing.xs
        },
        style
      ]}
    >
      <View style={[styles.dot, { backgroundColor: tone }]} />
      <Text style={{ color: theme.colors.text, fontSize: theme.typography.label }}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { alignItems: 'center', flexDirection: 'row', gap: 6 },
  dot: { borderRadius: 4, height: 8, width: 8 }
});
