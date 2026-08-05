import { SignalWireProvider, useSignalWire } from '@signalwire/react-native';
import React, { useMemo, useState } from 'react';
import { SafeAreaView, StyleSheet } from 'react-native';

import { IncomingCallSheet } from './src/components/IncomingCallSheet';
import { CallScreen } from './src/screens/CallScreen';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { HomeScreen } from './src/screens/HomeScreen';

import type { Call, CredentialProvider } from '@signalwire/js';

function Shell(): React.JSX.Element {
  const { isConnected } = useSignalWire();
  const [activeCall, setActiveCall] = useState<Call | null>(null);

  if (!isConnected) {
    return <ConnectScreen />;
  }

  if (activeCall) {
    return <CallScreen call={activeCall} onEnded={() => setActiveCall(null)} />;
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

  // Memoized: a new identity tears down the client and rebuilds it.
  const credentialProvider = useMemo<CredentialProvider | null>(
    () => (token ? { authenticate: async () => ({ token }) } : null),
    [token]
  );

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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b1020' }
});
