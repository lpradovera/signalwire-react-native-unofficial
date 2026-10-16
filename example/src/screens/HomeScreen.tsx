import { useObservable, useSignalWire } from '@signalwire/react-native';
import { CallOverlayHost } from '@signalwire/react-native-ui';
import React, { useEffect, useRef, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { createDialGuard } from '../dialGuard';

import type { Address, Call } from '@signalwire/js';

// Module scope, not a ref: HomeScreen unmounts while a call is active and
// remounts when it ends, so any per-mount guard re-arms after every call —
// which auto-dialed in a loop, forever. Once per app launch is the contract.
let autoDialConsumed = false;

export function HomeScreen({
  onCallStarted,
  onDisconnect
}: {
  onCallStarted: (call: Call) => void;
  /** The Disconnect button: the shell disconnects and offers Connect. */
  onDisconnect: () => void;
}): React.JSX.Element {
  const { user, directory, dial, error } = useSignalWire();
  const [dialError, setDialError] = useState<string | null>(null);
  // Seed from the synchronous getter, not a literal: `addresses$` is deferred
  // through asapScheduler like every SDK observable, so a `[]` here would show
  // an empty directory for a frame even when addresses are already loaded.
  const addresses = useObservable<Address[]>(directory?.addresses$, directory?.addresses ?? []);
  const [destination, setDestination] = useState('');
  const [aboutOpen, setAboutOpen] = useState(false);
  const [dialing, setDialing] = useState(false);
  // One dial at a time: a double tap otherwise placed two calls, and the first
  // stayed live with nothing in the app to end it. See dialGuard.
  const guard = useRef(createDialGuard(setDialing)).current;

  // The directory starts empty and does not fetch on its own — `addresses$` is
  // a BehaviorSubject seeded with []. Without this the list is permanently
  // "No addresses yet", which reads as "nothing to call" rather than "nothing
  // asked for them".
  useEffect(() => {
    directory?.loadMore();
  }, [directory]);

  // Dev convenience: dial automatically on reaching this screen. Device
  // testing otherwise needs a human to tap for every rebuild, which makes an
  // iteration loop over native fixes painfully slow. Unset in normal use.
  const autoDial = process.env.EXPO_PUBLIC_SW_AUTODIAL;
  useEffect(() => {
    if (!autoDial || autoDialConsumed) {
      return;
    }
    autoDialConsumed = true;
    void start(autoDial);
    // `start` is recreated every render; the module-scope guard makes this once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDial]);

  // Callers use `void start(...)`, so a rejection here would otherwise vanish
  // into an unhandled-promise warning instead of the screen.
  const start = async (target: string): Promise<void> => {
    if (!target.trim()) {
      return;
    }
    if (guard.pending) {
      return;
    }
    setDialError(null);
    try {
      // Video is opt-in: offering a sendonly video m-line to an audio-only
      // destination makes the far end accept the invite and never answer.
      // EXPO_PUBLIC_SW_DIAL_VIDEO=1 restores it.
      const wantVideo = process.env.EXPO_PUBLIC_SW_DIAL_VIDEO === '1';
      const call = await guard.run(() => dial(target.trim(), { audio: true, video: wantVideo }));
      if (call) {
        onCallStarted(call);
      }
    } catch (dialFailure) {
      setDialError((dialFailure as Error).message);
    }
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.name}>{user?.displayName ?? user?.email ?? 'Connected'}</Text>
        <View style={styles.links}>
          <Pressable onPress={() => setAboutOpen(true)} testID="about">
            <Text style={styles.link}>About</Text>
          </Pressable>
          <Pressable onPress={onDisconnect}>
            <Text style={styles.link}>Disconnect</Text>
          </Pressable>
        </View>
      </View>

      {/* An app Modal with its own CallOverlayHost: a call that rings while
          it is open draws its sheet over it, not behind it. */}
      <Modal visible={aboutOpen} animationType="slide" onRequestClose={() => setAboutOpen(false)}>
        <View style={styles.about}>
          <Text style={styles.name}>SignalWire RN Example</Text>
          <Text style={styles.empty}>Signed in as {user?.displayName ?? user?.email ?? 'unknown'}</Text>
          <Pressable style={styles.button} onPress={() => setAboutOpen(false)}>
            <Text style={styles.buttonLabel}>Close</Text>
          </Pressable>
        </View>
        {aboutOpen ? <CallOverlayHost /> : null}
      </Modal>

      {error ? <Text style={styles.error}>{error.message}</Text> : null}
      {dialError ? <Text style={styles.error}>Dial failed: {dialError}</Text> : null}

      <TextInput
        style={styles.input}
        value={destination}
        onChangeText={setDestination}
        placeholder="/public/my-room"
        placeholderTextColor="#64748b"
        autoCapitalize="none"
        autoCorrect={false}
        onSubmitEditing={() => void start(destination)}
      />

      <Pressable
        style={[styles.button, dialing && styles.disabled]}
        disabled={dialing}
        onPress={() => void start(destination)}
      >
        <Text style={styles.buttonLabel}>{dialing ? 'Calling…' : 'Call'}</Text>
      </Pressable>

      <Text style={styles.section}>Directory</Text>
      <FlatList
        data={addresses}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={<Text style={styles.empty}>No addresses yet.</Text>}
        renderItem={({ item }) => (
          <Pressable
            style={[styles.row, dialing && styles.disabled]}
            disabled={dialing}
            onPress={() => void start(item.id)}
          >
            <Text style={styles.rowTitle}>{item.displayName ?? item.name ?? item.id}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, gap: 12, padding: 20 },
  header: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  name: { color: '#f8fafc', fontSize: 16, fontWeight: '600' },
  link: { color: '#60a5fa', fontSize: 14 },
  links: { flexDirection: 'row', gap: 16 },
  about: { backgroundColor: '#0b1020', flex: 1, gap: 16, justifyContent: 'center', padding: 24 },
  error: { color: '#f87171', fontSize: 13 },
  input: { backgroundColor: '#1e293b', borderRadius: 12, color: '#f8fafc', padding: 14 },
  button: { backgroundColor: '#2563eb', borderRadius: 12, padding: 14 },
  buttonLabel: { color: '#fff', fontWeight: '700', textAlign: 'center' },
  disabled: { opacity: 0.5 },
  section: { color: '#94a3b8', fontSize: 13, marginTop: 8, textTransform: 'uppercase' },
  empty: { color: '#64748b', fontSize: 14 },
  row: { borderBottomColor: '#1e293b', borderBottomWidth: 1, paddingVertical: 14 },
  rowTitle: { color: '#e2e8f0', fontSize: 15 }
});
