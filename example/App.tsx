import { SignalWireProvider, useSignalWire } from '@signalwire/react-native';
import { getCallKit } from '@signalwire/react-native/callkit';
import React, { useEffect, useMemo, useState } from 'react';
import { SafeAreaView, StyleSheet } from 'react-native';

import { IncomingCallSheet } from './src/components/IncomingCallSheet';
import { CallScreen } from './src/screens/CallScreen';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { useBridgeAnswer } from './src/useBridgeAnswer';
import { SUBSCRIBER_REFERENCE } from './src/subscriber';
import { useDeviceRegistration } from './src/useDeviceRegistration';
import { useServerToken } from './src/useServerToken';

import type { Call, CredentialProvider } from '@signalwire/js';

function Shell(): React.JSX.Element {
  const { isConnected } = useSignalWire();
  const [activeCall, setActiveCall] = useState<Call | null>(null);
  // Must match the subscriber reference the token was minted for.
  useDeviceRegistration(SUBSCRIBER_REFERENCE);
  // Answering a parked-caller push means dialling, not answering — see the hook.
  useBridgeAnswer(setActiveCall);

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
  const serverToken = useServerToken();

  // The server token seeds state once; a manual entry always wins after that.
  useEffect(() => {
    if (serverToken.status === 'ready') {
      setToken((current) => current ?? serverToken.token);
    }
  }, [serverToken]);

  // Memoized: a new identity tears down the client and rebuilds it.
  const credentialProvider = useMemo<CredentialProvider | null>(
    () => (token ? { authenticate: async () => ({ token }) } : null),
    [token]
  );

  if (!credentialProvider) {
    return (
      <SafeAreaView style={styles.root}>
        <ConnectScreen
          onSubmitToken={setToken}
          fetching={serverToken.status === 'loading'}
          fetchError={serverToken.status === 'failed' ? serverToken.error : undefined}
        />
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
