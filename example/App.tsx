import { SignalWireProvider, useSignalWire } from '@signalwire/react-native';
import { getCallKit } from '@signalwire/react-native/callkit';
import { CallOverlayHost } from '@signalwire/react-native-ui';
import React, { useEffect, useMemo, useState } from 'react';
import { SafeAreaView, StyleSheet } from 'react-native';

import { IncomingCallSheet } from './src/components/IncomingCallSheet';
import { CallScreen } from './src/screens/CallScreen';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { useBridgeAnswer } from './src/useBridgeAnswer';
import { useCallBack } from './src/useCallBack';
import { SUBSCRIBER_REFERENCE } from './src/subscriber';
import { fetchServerToken } from './src/serverToken';
import { useDeviceRegistration } from './src/useDeviceRegistration';

import type { Call, CredentialProvider } from '@signalwire/js';

function Shell(): React.JSX.Element {
  const { isConnected } = useSignalWire();
  const [activeCall, setActiveCall] = useState<Call | null>(null);
  // Must match the subscriber reference the token was minted for.
  useDeviceRegistration(SUBSCRIBER_REFERENCE);
  // Answering a parked-caller push means dialling, not answering — see the hook.
  useBridgeAnswer(setActiveCall);
  // A tap in Recents, or "Hey Siri, call back": dial it.
  useCallBack(setActiveCall);

  // A CallKit Accept answers the call — audio and all — without touching
  // React. Subscribe to the registry so a native answer also brings up the
  // call screen; otherwise the accept button looks like it did nothing.
  useEffect(() => {
    const subscription = getCallKit().registry.answered$.subscribe(setActiveCall);
    return () => subscription.unsubscribe();
  }, []);

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
      <HomeScreen onCallStarted={setActiveCall} />
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
      <SafeAreaView style={styles.root}>
        <SignalWireProvider fetchToken={fetchServerToken} callKit platform={{ netInfo: true }}>
          <Shell />
        </SignalWireProvider>
      </SafeAreaView>
    );
  }

  if (!credentialProvider) {
    return (
      <SafeAreaView style={styles.root}>
        <ConnectScreen onSubmitToken={setToken} />
      </SafeAreaView>
    );
  }

  return (
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
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b1020' }
});
