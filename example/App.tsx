import { SignalWireProvider, useCalls, useSignalWire } from '@signalwire/react-native';
import { getCallKit } from '@signalwire/react-native/callkit';
import { CallOverlayHost } from '@signalwire/react-native-ui';
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet } from 'react-native';
// React Native's own SafeAreaView is iOS-only; on Android 15+ (edge-to-edge is
// enforced for targetSdk 35+) it applies no insets, so content drew under the
// status bar and the in-call buttons under the navigation bar, where taps go
// to the system instead of the app.
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { IncomingCallSheet } from './src/components/IncomingCallSheet';
import { CallScreen } from './src/screens/CallScreen';
import { ConnectScreen, DisconnectedScreen } from './src/screens/ConnectScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { useBridgeAnswer } from './src/useBridgeAnswer';
import { useCallBack } from './src/useCallBack';
import { useBridgeDecline } from './src/useBridgeDecline';
import { fetchServerToken, useServerReference } from './src/fetchServerToken';
import { useDeviceRegistration } from './src/useDeviceRegistration';
import { useDevStats } from './src/useDevStats';

import type { Call, CredentialProvider } from '@signalwire/js';

/**
 * The native call UI (CallKit / Telecom). EXPO_PUBLIC_SW_CALLKIT=0 builds
 * plain WebRTC calls instead; on Android the provider then runs its own
 * microphone foreground service during a call.
 */
const CALL_KIT = process.env.EXPO_PUBLIC_SW_CALLKIT !== '0';

/** A pasted subscriber token, and the subscriber it was minted for when known. */
interface Credentials {
  token: string;
  reference: string | null;
}

/**
 * `reference`: the subscriber the token was minted for; `undefined` while the
 * token server has not said yet, `null` for a pasted token without one.
 */
function Shell({ reference }: { reference: string | null | undefined }): React.JSX.Element {
  const { isConnected, connect, disconnect } = useSignalWire();
  const [activeCall, setActiveCall] = useState<Call | null>(null);
  // Every call in progress, from the SDK: the one with live media, and those
  // on hold (call waiting). It also finds a call that outlived the UI: Back
  // closes the activity on Android while the call goes on, and the provider
  // keeps it; the app comes back to it from the ongoing-call notification.
  const { activeCall: liveCall, heldCalls } = useCalls();
  const shownCall = liveCall ?? heldCalls[heldCalls.length - 1] ?? activeCall;
  // Set by the Disconnect button: the SDK does not reconnect after an explicit
  // disconnect, so this offers Connect instead of "Connecting…" forever.
  const [disconnected, setDisconnected] = useState(false);
  // The subscriber the signed-in token was minted for: the server's answer,
  // or what was entered beside a pasted token. A build-time constant here
  // registered a pasted token's device under another subscriber.
  useDeviceRegistration(reference);
  // EXPO_PUBLIC_SW_DEV_STATS=1: per-call RTP counters in the log.
  useDevStats();
  // Answering a parked-caller push means dialling, not answering — see the hook.
  useBridgeAnswer(setActiveCall);
  // A tap in Recents, or "Hey Siri, call back": dial it.
  useCallBack(setActiveCall);
  // Declining one means telling the server, which holds the caller.
  useBridgeDecline();

  // A CallKit Accept answers the call — audio and all — without touching
  // React. Subscribe to the registry so a native answer also brings up the
  // call screen; otherwise the accept button looks like it did nothing.
  useEffect(() => {
    const subscription = getCallKit().registry.answered$.subscribe(setActiveCall);
    return () => subscription.unsubscribe();
  }, []);

  if (disconnected) {
    return (
      <DisconnectedScreen
        onConnect={() => {
          setDisconnected(false);
          void connect();
        }}
      />
    );
  }

  if (!isConnected) {
    return <ConnectScreen />;
  }

  if (shownCall) {
    // Keyed by the call: End & Accept or a swap replaces the call shown while
    // this screen is up, and the next call gets a fresh screen (and fresh
    // hook state) rather than the other call's. The sheet stays mounted over
    // it, so a second call rings here too (Hold & Accept, End & Accept).
    return (
      <>
        <CallScreen
          key={shownCall.id}
          call={shownCall}
          onEnded={() => setActiveCall((current) => (current === shownCall ? null : current))}
        />
        <IncomingCallSheet onAnswered={setActiveCall} />
      </>
    );
  }

  return (
    <>
      <HomeScreen
        onCallStarted={setActiveCall}
        onDisconnect={() => {
          setDisconnected(true);
          void disconnect();
        }}
      />
      <IncomingCallSheet onAnswered={setActiveCall} />
    </>
  );
}

/** The fetchToken path: the server says whose token it minted. */
function ServerShell(): React.JSX.Element {
  return <Shell reference={useServerReference()} />;
}

export default function App(): React.JSX.Element {
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const token = credentials?.token;

  // A pasted token: a plain credentialProvider, never renewed. Memoized: a
  // new identity tears down the client and rebuilds it.
  const credentialProvider = useMemo<CredentialProvider | null>(
    () => (token ? { authenticate: async () => ({ token }) } : null),
    [token]
  );

  // With a token server the provider fetches, renews and retries the token
  // itself, from launch: a push-woken cold start connects the same way.
  if (fetchServerToken) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.root}>
          <SignalWireProvider
            fetchToken={fetchServerToken}
            callKit={CALL_KIT}
            platform={{ netInfo: true }}
          >
            <ServerShell />
          </SignalWireProvider>
          {/* Last in the root: the incoming-call sheet draws here, not in a Modal. */}
          <CallOverlayHost />
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  if (!credentialProvider) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.root}>
          <ConnectScreen onSubmitToken={(pasted, reference) => setCredentials({ token: pasted, reference })} />
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root}>
        <SignalWireProvider
          credentialProvider={credentialProvider}
          callKit={CALL_KIT}
          platform={{ netInfo: true }}
        >
          <Shell reference={credentials?.reference ?? null} />
        </SignalWireProvider>
        {/* Last in the root: the incoming-call sheet draws here, not in a Modal. */}
        <CallOverlayHost />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b1020' }
});
