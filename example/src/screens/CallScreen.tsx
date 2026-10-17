import { SignalWireVideoView, useCall, useSignalWire } from '@signalwire/react-native';
import { CallControls, CallStatus } from '@signalwire/react-native-ui';
import React, { useEffect, useState } from 'react';
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
      {DIAL_AGAIN_TARGET ? <DialAgain target={DIAL_AGAIN_TARGET} /> : null}
      <CallControls call={call} onHangup={onEnded} style={styles.controls} />
    </View>
  );
}

/**
 * Dev only: `EXPO_PUBLIC_SW_DEV_DIAL_AGAIN=<address>` puts a "Dial again"
 * button on the call screen that dials that address while this call is live,
 * to show the library refusing a second call (`CallInProgressError`) from a
 * real build. Unset, there is no button.
 */
const DIAL_AGAIN_TARGET = process.env.EXPO_PUBLIC_SW_DEV_DIAL_AGAIN?.trim() || undefined;

function DialAgain({ target }: { target: string }): React.JSX.Element {
  const { dial } = useSignalWire();
  const [result, setResult] = useState<string | null>(null);

  const dialAgain = async (): Promise<void> => {
    try {
      const second = await dial(target, { audio: true, video: false });
      // Not expected: the library should have refused it. End it at once.
      setResult(`Not refused: placed ${second.id}; hanging it up`);
      void second.hangup().catch(() => undefined);
    } catch (error) {
      const { name, message } = error as Error;
      console.warn(`Dial again: ${name}: ${message}`);
      setResult(`${name}: ${message}`);
    }
  };

  return (
    <View style={styles.dialAgain}>
      <Pressable style={styles.dialAgainButton} onPress={() => void dialAgain()} testID="dial-again">
        <Text style={styles.dialAgainLabel}>Dial again (dev)</Text>
      </Pressable>
      {result ? <Text style={styles.dialAgainResult}>{result}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: '#000', flex: 1 },
  remote: { ...StyleSheet.absoluteFillObject },
  local: { borderRadius: 12, height: 160, position: 'absolute', right: 16, top: 24, width: 108 },
  status: { left: 16, position: 'absolute', top: 24 },
  controls: { bottom: 32, left: 0, position: 'absolute', right: 0 },
  dialAgain: { gap: 6, left: 16, position: 'absolute', right: 16, top: 200 },
  dialAgainButton: { alignSelf: 'flex-start', backgroundColor: '#334155', borderRadius: 8, padding: 10 },
  dialAgainLabel: { color: '#f8fafc', fontWeight: '600' },
  dialAgainResult: { color: '#fca5a5', fontSize: 13 }
});
