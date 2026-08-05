import { useIncomingCalls } from '@signalwire/react-native';
import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Call } from '@signalwire/js';

/**
 * In-app inbound call UI.
 *
 * With `callKit` enabled the native CallKit / ConnectionService screen usually
 * handles inbound calls first — this covers the foreground case and apps that
 * run without native call UI.
 */
export function IncomingCallSheet({
  onAnswered
}: {
  onAnswered: (call: Call) => void;
}): React.JSX.Element | null {
  const { calls, answer, reject } = useIncomingCalls();
  const call = calls[0];

  if (!call) {
    return null;
  }

  return (
    <Modal transparent animationType="slide" visible>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Incoming call</Text>
          <Text style={styles.caller}>{call.fromName ?? call.from ?? 'Unknown caller'}</Text>

          <View style={styles.actions}>
            <Pressable
              style={[styles.button, styles.decline]}
              onPress={() => void reject(call)}
            >
              <Text style={styles.label}>Decline</Text>
            </Pressable>
            <Pressable
              style={[styles.button, styles.accept]}
              onPress={() => {
                void answer(call, { audio: true, video: true }).then(() => onAnswered(call));
              }}
            >
              <Text style={styles.label}>Answer</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: 'rgba(0,0,0,0.6)', flex: 1, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#0f172a',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    gap: 8,
    padding: 24
  },
  title: { color: '#94a3b8', fontSize: 13, textTransform: 'uppercase' },
  caller: { color: '#f8fafc', fontSize: 24, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: 12, marginTop: 16 },
  button: { borderRadius: 24, flex: 1, padding: 16 },
  decline: { backgroundColor: '#dc2626' },
  accept: { backgroundColor: '#16a34a' },
  label: { color: '#fff', fontWeight: '700', textAlign: 'center' }
});
