import { useObservable, useSignalWire } from '@signalwire/react-native';
import React, { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { Address, Call } from '@signalwire/js';

export function HomeScreen({
  onCallStarted
}: {
  onCallStarted: (call: Call) => void;
}): React.JSX.Element {
  const { user, directory, dial, disconnect, error } = useSignalWire();
  // Seed from the synchronous getter, not a literal: `addresses$` is deferred
  // through asapScheduler like every SDK observable, so a `[]` here would show
  // an empty directory for a frame even when addresses are already loaded.
  const addresses = useObservable<Address[]>(directory?.addresses$, directory?.addresses ?? []);
  const [destination, setDestination] = useState('');

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
  const autoDialed = useRef(false);
  useEffect(() => {
    if (!autoDial || autoDialed.current) {
      return;
    }
    autoDialed.current = true;
    void start(autoDial);
    // `start` is recreated every render; the ref guard is what makes this once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDial]);

  const start = async (target: string): Promise<void> => {
    if (!target.trim()) {
      return;
    }
    const call = await dial(target.trim(), { audio: true, video: true });
    onCallStarted(call);
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.name}>{user?.displayName ?? user?.email ?? 'Connected'}</Text>
        <Pressable onPress={() => void disconnect()}>
          <Text style={styles.link}>Disconnect</Text>
        </Pressable>
      </View>

      {error ? <Text style={styles.error}>{error.message}</Text> : null}

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

      <Pressable style={styles.button} onPress={() => void start(destination)}>
        <Text style={styles.buttonLabel}>Call</Text>
      </Pressable>

      <Text style={styles.section}>Directory</Text>
      <FlatList
        data={addresses}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={<Text style={styles.empty}>No addresses yet.</Text>}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => void start(item.id)}>
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
  error: { color: '#f87171', fontSize: 13 },
  input: { backgroundColor: '#1e293b', borderRadius: 12, color: '#f8fafc', padding: 14 },
  button: { backgroundColor: '#2563eb', borderRadius: 12, padding: 14 },
  buttonLabel: { color: '#fff', fontWeight: '700', textAlign: 'center' },
  section: { color: '#94a3b8', fontSize: 13, marginTop: 8, textTransform: 'uppercase' },
  empty: { color: '#64748b', fontSize: 14 },
  row: { borderBottomColor: '#1e293b', borderBottomWidth: 1, paddingVertical: 14 },
  rowTitle: { color: '#e2e8f0', fontSize: 15 }
});
