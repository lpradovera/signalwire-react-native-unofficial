import { SignalWireVideoView, useCall } from '@signalwire/react-native';
import { CallControls, CallStatus } from '@signalwire/react-native-ui';
import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import type { Call } from '@signalwire/js';

const TERMINAL = new Set(['disconnected', 'destroyed', 'failed']);

export function CallScreen({
  call,
  onEnded
}: {
  call: Call;
  onEnded: () => void;
}): React.JSX.Element {
  const { status } = useCall(call);

  useEffect(() => {
    if (TERMINAL.has(status)) {
      onEnded();
    }
  }, [status, onEnded]);

  return (
    <View style={styles.root}>
      <SignalWireVideoView call={call} kind="remote" style={styles.remote} objectFit="cover" />
      <SignalWireVideoView call={call} kind="local" style={styles.local} objectFit="cover" />

      <CallStatus call={call} style={styles.status} />
      <CallControls call={call} onHangup={onEnded} style={styles.controls} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: '#000', flex: 1 },
  remote: { ...StyleSheet.absoluteFillObject },
  local: { borderRadius: 12, height: 160, position: 'absolute', right: 16, top: 24, width: 108 },
  status: { left: 16, position: 'absolute', top: 24 },
  controls: { bottom: 32, left: 0, position: 'absolute', right: 0 }
});
