import { SignalWireVideoView, useCall } from '@signalwire/react-native';
import { useAudioRoute } from '@signalwire/react-native/audio';
import React, { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Call } from '@signalwire/js';

const TERMINAL = new Set(['disconnected', 'destroyed', 'failed']);

export function CallScreen({
  call,
  onEnded
}: {
  call: Call;
  onEnded: () => void;
}): React.JSX.Element {
  const { status, isAudioMuted, isVideoMuted, setAudioMuted, setVideoMuted, hangup, error } =
    useCall(call);
  const { route, setRoute } = useAudioRoute();

  useEffect(() => {
    if (TERMINAL.has(status)) {
      onEnded();
    }
  }, [status, onEnded]);

  return (
    <View style={styles.root}>
      <SignalWireVideoView call={call} kind="remote" style={styles.remote} objectFit="cover" />
      <SignalWireVideoView call={call} kind="local" style={styles.local} objectFit="cover" />

      <Text style={styles.status}>{error ? `${error.kind} error` : status}</Text>

      <View style={styles.controls}>
        <Pressable style={styles.button} onPress={() => void setAudioMuted(!isAudioMuted)}>
          <Text style={styles.label}>{isAudioMuted ? 'Unmute' : 'Mute'}</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={() => void setVideoMuted(!isVideoMuted)}>
          <Text style={styles.label}>{isVideoMuted ? 'Camera on' : 'Camera off'}</Text>
        </Pressable>
        <Pressable
          style={styles.button}
          onPress={() => setRoute(route === 'speaker' ? 'earpiece' : 'speaker')}
        >
          <Text style={styles.label}>{route}</Text>
        </Pressable>
        <Pressable style={[styles.button, styles.hangup]} onPress={() => void hangup()}>
          <Text style={styles.label}>End</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: '#000', flex: 1 },
  remote: { ...StyleSheet.absoluteFillObject },
  local: {
    borderRadius: 12,
    height: 160,
    position: 'absolute',
    right: 16,
    top: 24,
    width: 108
  },
  status: { color: '#fff', left: 16, position: 'absolute', top: 24 },
  controls: {
    bottom: 40,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0
  },
  button: {
    backgroundColor: '#1f2937',
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 12
  },
  hangup: { backgroundColor: '#dc2626' },
  label: { color: '#fff', fontWeight: '600' }
});
