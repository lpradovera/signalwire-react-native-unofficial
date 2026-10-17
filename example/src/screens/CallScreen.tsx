import { SignalWireVideoView, useCall, useCalls, useSignalWire } from '@signalwire/react-native';
import { displayableName } from '@signalwire/react-native/ringing';
import { CallControls, CallStatus } from '@signalwire/react-native-ui';
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Call } from '@signalwire/js';

// Not 'disconnected': that is an ICE blip the SDK recovers from, and leaving
// the screen there left a live call nothing in the app could hang up. A call
// that does not recover ends 'failed'.
const TERMINAL = new Set(['destroyed', 'failed']);

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
      <HoldBar call={call} />
      {DIAL_AGAIN_TARGET ? <DialAgain target={DIAL_AGAIN_TARGET} /> : null}
      <CallControls call={call} onHangup={onEnded} style={styles.controls} />
    </View>
  );
}

function nameOf(call: Call): string {
  return displayableName(call.fromName, 'CallScreen') ?? displayableName(call.from ?? call.to, 'CallScreen') ?? 'Call';
}

/**
 * Call waiting: Hold or Resume for this call, and each other call on hold
 * with Swap (hold this one, resume that one) and End.
 */
function HoldBar({ call }: { call: Call }): React.JSX.Element {
  const { heldCalls, isHeld, hold, unhold, swap } = useCalls();
  const held = heldCalls.includes(call) || isHeld(call);
  const others = heldCalls.filter((other) => other !== call);
  const run = (action: () => Promise<void>): void => {
    action().catch((error: unknown) => console.warn('Hold failed:', error));
  };

  return (
    <View style={styles.holdBar} testID="hold-bar">
      <Pressable
        style={styles.holdButton}
        testID={held ? 'resume-call' : 'hold-call'}
        onPress={() => run(() => (held ? unhold(call) : hold(call)))}
      >
        <Text style={styles.holdLabel}>{held ? 'On hold · Resume' : 'Hold'}</Text>
      </Pressable>
      {others.map((other) => (
        <View key={other.id} style={styles.heldRow} testID="held-call">
          <Text style={styles.heldName}>On hold: {nameOf(other)}</Text>
          <Pressable style={styles.holdButton} testID="swap-call" onPress={() => run(swap)}>
            <Text style={styles.holdLabel}>Swap</Text>
          </Pressable>
          <Pressable
            style={[styles.holdButton, styles.endButton]}
            testID="end-held-call"
            onPress={() => run(() => other.hangup())}
          >
            <Text style={styles.holdLabel}>End</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

/**
 * Dev only: `EXPO_PUBLIC_SW_DEV_DIAL_AGAIN=<address>` puts a "Dial again"
 * button on the call screen that dials that address while this call is live:
 * with call waiting ('full') a second call that puts this one on hold, in the
 * other modes a refusal (`CallInProgressError`). Unset, there is no button.
 */
const DIAL_AGAIN_TARGET = process.env.EXPO_PUBLIC_SW_DEV_DIAL_AGAIN?.trim() || undefined;

function DialAgain({ target }: { target: string }): React.JSX.Element {
  const { dial } = useSignalWire();
  const [result, setResult] = useState<string | null>(null);

  const dialAgain = async (): Promise<void> => {
    try {
      const second = await dial(target, { audio: true, video: false });
      // Call waiting: the second call is up, and this one is on hold.
      setResult(`Placed ${second.id}`);
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
  dialAgain: { gap: 6, left: 16, position: 'absolute', right: 16, top: 280 },
  dialAgainButton: { alignSelf: 'flex-start', backgroundColor: '#334155', borderRadius: 8, padding: 10 },
  dialAgainLabel: { color: '#f8fafc', fontWeight: '600' },
  dialAgainResult: { color: '#fca5a5', fontSize: 13 },
  holdBar: { gap: 8, left: 16, position: 'absolute', right: 16, top: 80 },
  heldRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  heldName: { color: '#f8fafc', flex: 1, fontSize: 15 },
  holdButton: { alignSelf: 'flex-start', backgroundColor: '#334155', borderRadius: 8, padding: 10 },
  endButton: { backgroundColor: '#b91c1c' },
  holdLabel: { color: '#f8fafc', fontWeight: '600' }
});
