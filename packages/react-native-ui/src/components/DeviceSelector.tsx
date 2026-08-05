import { useDevices } from '@signalwire/react';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useSignalWireTheme } from '../theme/ThemeProvider';

import type { StyleProp, ViewStyle } from 'react-native';

export interface DeviceSelectorProps {
  /** Which input to list. */
  kind: 'audio' | 'video';
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * Picks a microphone or camera.
 *
 * Inputs only. Audio *output* is absent because React Native has no
 * `setSinkId`; routing between earpiece, speaker and Bluetooth belongs to
 * `useAudioRoute`, which `CallControls` exposes.
 *
 * React Native emits no `devicechange`, so the list refreshes on mount rather
 * than tracking the OS.
 */
export function DeviceSelector({ kind, style, testID }: DeviceSelectorProps): React.JSX.Element {
  const theme = useSignalWireTheme();
  const {
    audioInputs,
    videoInputs,
    selectedAudioInput,
    selectedVideoInput,
    selectAudioInput,
    selectVideoInput,
    refresh
  } = useDevices();

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const devices = kind === 'audio' ? audioInputs : videoInputs;
  const selected = kind === 'audio' ? selectedAudioInput : selectedVideoInput;
  const select = kind === 'audio' ? selectAudioInput : selectVideoInput;

  return (
    <ScrollView testID={testID} style={style}>
      {devices.length === 0 ? (
        <Text style={{ color: theme.colors.textMuted, padding: theme.spacing.lg }}>
          No {kind === 'audio' ? 'microphones' : 'cameras'} found.
        </Text>
      ) : null}

      {devices.map((device) => {
        const isSelected = selected?.deviceId === device.deviceId;
        return (
          <Pressable
            key={device.deviceId}
            testID={`sw-device-${device.deviceId}`}
            onPress={() => select(device)}
            accessibilityRole="radio"
            accessibilityState={{ selected: isSelected }}
            accessibilityLabel={device.label || 'Unnamed device'}
            style={[
              styles.row,
              {
                backgroundColor: isSelected ? theme.colors.surfaceActive : 'transparent',
                borderBottomColor: theme.colors.border,
                padding: theme.spacing.md
              }
            ]}
          >
            <Text style={{ color: theme.colors.text, flex: 1, fontSize: theme.typography.body }}>
              {device.label || 'Unnamed device'}
            </Text>
            {isSelected ? (
              <View style={[styles.check, { backgroundColor: theme.colors.accent }]} />
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row' },
  check: { borderRadius: 6, height: 12, width: 12 }
});
