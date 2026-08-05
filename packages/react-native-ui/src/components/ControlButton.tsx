import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { useSignalWireTheme } from '../theme/ThemeProvider';

import type { StyleProp, ViewStyle } from 'react-native';

export interface ControlButtonProps {
  label: string;
  onPress: () => void;
  /** Renders in the destructive colour. Use for hang up and decline. */
  variant?: 'default' | 'accent' | 'danger';
  /** Reflected to assistive tech as a toggle state. */
  active?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The single pressable used across the kit.
 *
 * Labels are text rather than icons on purpose: an icon set would mean either a
 * dependency (`react-native-svg`) or bundled glyphs, and text labels are
 * legible to screen readers without extra `accessibilityLabel` plumbing. Apps
 * wanting icons can compose their own button and use the hooks directly.
 */
export function ControlButton({
  label,
  onPress,
  variant = 'default',
  active = false,
  disabled = false,
  style,
  testID
}: ControlButtonProps): React.JSX.Element {
  const theme = useSignalWireTheme();

  const background =
    variant === 'danger'
      ? theme.colors.danger
      : variant === 'accent'
        ? theme.colors.accent
        : active
          ? theme.colors.surfaceActive
          : theme.colors.surface;

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected: active }}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: background,
          borderRadius: theme.radii.pill,
          paddingHorizontal: theme.spacing.lg,
          paddingVertical: theme.spacing.md,
          opacity: disabled ? 0.5 : pressed ? 0.8 : 1
        },
        style
      ]}
    >
      <Text style={[styles.label, { color: theme.colors.text, fontSize: theme.typography.label }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center' },
  label: { fontWeight: '600' }
});
