import { SignalWireProvider, useSignalWire } from '@signalwire/react-native';
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
import { SUBSCRIBER_REFERENCE } from './src/subscriber';
import { fetchServerToken } from './src/serverToken';
import { useDeviceRegistration } from './src/useDeviceRegistration';

import type { Call, CredentialProvider } from '@signalwire/js';

function Shell(): React.JSX.Element {
  const { isConnected, connect, disconnect } = useSignalWire();
  const [activeCall, setActiveCall] = useState<Call | null>(null);
  // Set by the Disconnect button: the SDK does not reconnect after an explicit
  // disconnect, so this offers Connect instead of "Connecting…" forever.
  const [disconnected, setDisconnected] = useState(false);
  // Must match the subscriber reference the token was minted for.
  useDeviceRegistration(SUBSCRIBER_REFERENCE);
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

  if (activeCall) {
    // Keyed by the call: End & Accept replaces the active call while this
    // screen is up, and the next call gets a fresh screen (and fresh hook
    // state) rather than the ended call's.
    return <CallScreen key={activeCall.id} call={activeCall} onEnded={() => setActiveCall(null)} />;
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

export default function App(): React.JSX.Element {
  const [token, setToken] = useState<string | null>(null);

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
          <SignalWireProvider fetchToken={fetchServerToken} callKit platform={{ netInfo: true }}>
            <Shell />
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
          <ConnectScreen onSubmitToken={setToken} />
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root}>
        <SignalWireProvider
          credentialProvider={credentialProvider}
          callKit
          platform={{ netInfo: true }}
        >
          <Shell />
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
