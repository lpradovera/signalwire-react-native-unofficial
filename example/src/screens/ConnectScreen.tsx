import { useSignalWire } from '@signalwire/react-native';
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

/**
 * Two roles, decided by `onSubmitToken`:
 * - with it, this is the token entry form, rendered before a provider exists;
 * - without it, this is the "connecting" state rendered inside the provider.
 *
 * The form stays usable while a server request is pending, so a slow or
 * unreachable server never stands between the developer and a pasted token.
 */
export function ConnectScreen({
  onSubmitToken,
  fetching = false,
  fetchError,
  onRetry
}: {
  /**
   * `reference` is the subscriber the pasted token was minted for, or null
   * when none was given — push registration needs it and is skipped without.
   */
  onSubmitToken?: (token: string, reference: string | null) => void;
  /** A token request to the support server is in flight. */
  fetching?: boolean;
  /** Why the support server could not supply one. */
  fetchError?: string;
  /** Asks the support server again; offered after a failure. */
  onRetry?: () => void;
}): React.JSX.Element {
  const [token, setToken] = useState('');
  const [reference, setReference] = useState('');

  if (!onSubmitToken) {
    return <ConnectingState />;
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title}>SignalWire</Text>
      {fetching ? (
        <View style={styles.row}>
          <ActivityIndicator color="#60a5fa" />
          <Text style={styles.subtitle}>Requesting a token from the server…</Text>
        </View>
      ) : null}
      {fetchError ? (
        <View style={styles.row}>
          <Text style={styles.error}>Token server: {fetchError}</Text>
          {onRetry ? (
            <Pressable onPress={onRetry}>
              <Text style={styles.link}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <Text style={styles.subtitle}>Paste a subscriber token to connect.</Text>

      {/* Uncontrolled: `token` follows the field and is never written back,
          so a re-render while pasting or typing cannot replace the text. */}
      <TextInput
        style={styles.input}
        onChangeText={setToken}
        placeholder="Subscriber access token"
        placeholderTextColor="#64748b"
        autoCapitalize="none"
        autoCorrect={false}
        multiline
      />

      <TextInput
        style={styles.referenceInput}
        onChangeText={setReference}
        placeholder="Subscriber reference the token was minted for"
        placeholderTextColor="#64748b"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Text style={styles.hint}>
        Used to register this device for incoming calls. Leave it empty to skip push
        registration: a device registered under another subscriber rings for their calls
        and cannot answer them.
      </Text>

      <Pressable
        style={[styles.button, !token.trim() && styles.buttonDisabled]}
        disabled={!token.trim()}
        onPress={() => onSubmitToken(token.trim(), reference.trim() || null)}
      >
        <Text style={styles.buttonLabel}>Connect</Text>
      </Pressable>
    </View>
  );
}

/** After the Disconnect button: the client stays disconnected until asked. */
export function DisconnectedScreen({ onConnect }: { onConnect: () => void }): React.JSX.Element {
  return (
    <View style={styles.root}>
      <Text style={styles.subtitle}>Disconnected.</Text>
      <Pressable style={styles.button} onPress={onConnect}>
        <Text style={styles.buttonLabel}>Connect</Text>
      </Pressable>
    </View>
  );
}

function ConnectingState(): React.JSX.Element {
  const { error, tokenStatus } = useSignalWire();

  if (tokenStatus?.state === 'unauthorized') {
    // Not retried: until the user is signed in again, no call can reach
    // this device, so say so rather than spin.
    return (
      <View style={styles.root}>
        <Text style={styles.error}>The token server refused this device: {tokenStatus.error?.message}</Text>
        <Text style={styles.subtitle}>Incoming calls cannot reach it until it is signed in again.</Text>
      </View>
    );
  }

  const status =
    tokenStatus?.state === 'retrying'
      ? `Token server unreachable, retrying: ${tokenStatus.error?.message ?? ''}`
      : tokenStatus?.state === 'fetching'
        ? 'Requesting a token from the server…'
        : error
          ? error.message
          : 'Connecting…';

  return (
    <View style={styles.root}>
      <ActivityIndicator color="#60a5fa" />
      <Text style={styles.subtitle}>{status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center', padding: 24, gap: 16 },
  title: { color: '#f8fafc', fontSize: 32, fontWeight: '700' },
  subtitle: { color: '#94a3b8', fontSize: 15, textAlign: 'center' },
  error: { color: '#f87171', flexShrink: 1, fontSize: 13, textAlign: 'center' },
  row: { alignItems: 'center', flexDirection: 'row', gap: 12, justifyContent: 'center' },
  link: { color: '#60a5fa', fontWeight: '600' },
  hint: { color: '#64748b', fontSize: 12 },
  referenceInput: { backgroundColor: '#1e293b', borderRadius: 12, color: '#f8fafc', padding: 14 },
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
