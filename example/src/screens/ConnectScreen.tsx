import { useSignalWire } from '@signalwire/react-native';
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

/**
 * Two roles, decided by `onSubmitToken`:
 * - with it, this is the token entry form, rendered before a provider exists;
 * - without it, this is the "connecting" state rendered inside the provider.
 */
export function ConnectScreen({
  onSubmitToken,
  fetching = false,
  fetchError
}: {
  onSubmitToken?: (token: string) => void;
  /** A token request to the support server is in flight. */
  fetching?: boolean;
  /** Why the support server could not supply one. */
  fetchError?: string;
}): React.JSX.Element {
  const [token, setToken] = useState('');

  if (!onSubmitToken) {
    return <ConnectingState />;
  }

  if (fetching) {
    return (
      <View style={styles.root}>
        <ActivityIndicator color="#60a5fa" />
        <Text style={styles.subtitle}>Requesting a token from the server…</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title}>SignalWire</Text>
      <Text style={styles.subtitle}>Paste a subscriber token to connect.</Text>
      {fetchError ? <Text style={styles.error}>Token server: {fetchError}</Text> : null}

      <TextInput
        style={styles.input}
        value={token}
        onChangeText={setToken}
        placeholder="Subscriber access token"
        placeholderTextColor="#64748b"
        autoCapitalize="none"
        autoCorrect={false}
        multiline
      />

      <Pressable
        style={[styles.button, !token.trim() && styles.buttonDisabled]}
        disabled={!token.trim()}
        onPress={() => onSubmitToken(token.trim())}
      >
        <Text style={styles.buttonLabel}>Connect</Text>
      </Pressable>
    </View>
  );
}

function ConnectingState(): React.JSX.Element {
  const { error } = useSignalWire();

  return (
    <View style={styles.root}>
      <ActivityIndicator color="#60a5fa" />
      <Text style={styles.subtitle}>{error ? error.message : 'Connecting…'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center', padding: 24, gap: 16 },
  title: { color: '#f8fafc', fontSize: 32, fontWeight: '700' },
  subtitle: { color: '#94a3b8', fontSize: 15, textAlign: 'center' },
  error: { color: '#f87171', fontSize: 13, textAlign: 'center' },
  input: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    color: '#f8fafc',
    minHeight: 96,
    padding: 14
  },
  button: { backgroundColor: '#2563eb', borderRadius: 12, padding: 16 },
  buttonDisabled: { backgroundColor: '#1e3a5f' },
  buttonLabel: { color: '#fff', fontWeight: '700', textAlign: 'center' }
});
