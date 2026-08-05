import { useCall } from '@signalwire/react';
import React, { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useSignalWireTheme } from '../theme/ThemeProvider';

import type { Call } from '@signalwire/js';
import type { StyleProp, ViewStyle } from 'react-native';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'] as const;

export interface DialpadProps {
  /** When given, presses send DTMF on the call. */
  call?: Call | null;
  /** Also called on every press, for building a destination string. */
  onDigit?: (digit: string) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * A DTMF keypad.
 *
 * Works with or without a call: pass `call` to send tones in-call, or use
 * `onDigit` alone to compose a number before dialling.
 */
export function Dialpad({ call, onDigit, style, testID }: DialpadProps): React.JSX.Element {
  const theme = useSignalWireTheme();
  const { sendDigits } = useCall(call);

  const press = useCallback(
    (digit: string) => {
      onDigit?.(digit);
      if (call) {
        void sendDigits(digit);
      }
    },
    [call, onDigit, sendDigits]
  );

  return (
    <View testID={testID} style={[styles.grid, { gap: theme.spacing.sm }, style]}>
      {KEYS.map((key) => (
        <Pressable
          key={key}
          testID={`sw-key-${key}`}
          onPress={() => press(key)}
          accessibilityRole="button"
          accessibilityLabel={`Dial ${key}`}
          style={({ pressed }) => [
            styles.key,
            {
              backgroundColor: pressed ? theme.colors.surfaceActive : theme.colors.surface,
              borderRadius: theme.radii.pill
            }
          ]}
        >
          <Text style={{ color: theme.colors.text, fontSize: theme.typography.title }}>{key}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', maxWidth: 260 },
  key: { alignItems: 'center', height: 72, justifyContent: 'center', width: 72 }
});
