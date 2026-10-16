import { SignalWireProvider, useSignalWire } from '@signalwire/react-native';
import { getCallKit } from '@signalwire/react-native/callkit';
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { IncomingCallSheet } from './src/components/IncomingCallSheet';
import { CallScreen } from './src/screens/CallScreen';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { useBridgeAnswer } from './src/useBridgeAnswer';
import { useDeviceRegistration } from './src/useDeviceRegistration';
import { useServerToken } from './src/useServerToken';

import type { Call, CredentialProvider } from '@signalwire/js';

/** A subscriber token, and the subscriber it was minted for when known. */
interface Credentials {
  token: string;
  reference: string | null;
}

function Shell({ reference }: { reference: string | null }): React.JSX.Element {
  const { isConnected } = useSignalWire();
  const [activeCall, setActiveCall] = useState<Call | null>(null);
  // The subscriber the signed-in token was minted for: the server's answer,
  // or what was entered beside a pasted token. A build-time constant here
  // registered a pasted token's device under another subscriber.
  useDeviceRegistration(reference);
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
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const serverToken = useServerToken();
  const serverCredentials =
    serverToken.status === 'ready'
      ? { token: serverToken.token, reference: serverToken.reference }
      : null;

  // The server token seeds state once; a manual entry always wins after that.
  const serverTokenValue = serverCredentials?.token;
  const serverReference = serverCredentials?.reference;
  useEffect(() => {
    if (serverTokenValue && serverReference) {
      setCredentials(
        (current) => current ?? { token: serverTokenValue, reference: serverReference }
      );
    }
  }, [serverTokenValue, serverReference]);

  // Memoized: a new identity tears down the client and rebuilds it.
  const token = credentials?.token;
  const credentialProvider = useMemo<CredentialProvider | null>(
    () => (token ? { authenticate: async () => ({ token }) } : null),
    [token]
  );

  // react-native-safe-area-context, not React Native's SafeAreaView: that one
  // is a plain View on Android, where Expo SDK 54 draws edge to edge, so the
  // header and the call controls sat under the status and navigation bars.
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root}>
        {credentialProvider ? (
          <SignalWireProvider
            credentialProvider={credentialProvider}
            callKit
            platform={{ netInfo: true }}
          >
            <Shell reference={credentials?.reference ?? null} />
          </SignalWireProvider>
        ) : (
          <ConnectScreen
            onSubmitToken={(pasted, reference) => setCredentials({ token: pasted, reference })}
            fetching={serverToken.status === 'loading'}
            fetchError={serverToken.status === 'failed' ? serverToken.error : undefined}
            onRetry={serverToken.retry}
          />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b1020' }
});
