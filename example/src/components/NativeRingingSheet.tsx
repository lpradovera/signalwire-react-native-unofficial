import { useRingingPushes } from '@signalwire/react-native/callkit';
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

/**
 * Draws incoming calls that the OS will not draw for us.
 *
 * iOS never renders this: CallKit shows its own screen, on the lock screen and
 * over other apps, before this app is even in front. Android does, because
 * callkeep is registered self-managed — Telecom tracks the call but draws no
 * UI for it by design, so without this the push lands, a connection exists,
 * and the user sees nothing at all.
 *
 * Answering applies the same intent a CallKit answer would, so both platforms
 * converge on one path and whatever places the call picks it up from there.
 */
export function NativeRingingSheet(): React.JSX.Element | null {
  const { ringing, answer, reject } = useRingingPushes();

  // Guarded rather than left to render nothing on iOS: CallKit is already
  // showing a call, and a second sheet behind it is confusing.
  if (Platform.OS !== 'android' || ringing.length === 0) {
    return null;
  }

  const call = ringing[0];

  return (
    <View style={styles.sheet}>
      <Text style={styles.label}>Incoming call</Text>
      <Text style={styles.caller}>{call.fromName || call.from || 'Unknown caller'}</Text>
      <View style={styles.row}>
        <Pressable
          style={[styles.button, styles.decline]}
          onPress={() => reject(call.uuid)}
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>Decline</Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.accept]}
          onPress={() => answer(call.uuid)}
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>Answer</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 24,
    backgroundColor: '#1b2233',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16
  },
  label: { color: '#8fa0bf', fontSize: 13, marginBottom: 4 },
  caller: { color: '#fff', fontSize: 22, fontWeight: '600', marginBottom: 20 },
  row: { flexDirection: 'row', gap: 12 },
  button: { flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  accept: { backgroundColor: '#2f6fed' },
  decline: { backgroundColor: '#c0392b' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 }
});
