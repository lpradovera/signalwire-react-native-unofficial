import { SignalWireProvider, useSignalWire } from '@signalwire/react';
import React, { useMemo, useState } from 'react';

import { CallView } from './CallView';

import type { Call, CredentialProvider } from '@signalwire/js';

function Dialer(): React.JSX.Element {
  const { isConnected, user, dial, error } = useSignalWire();
  const [destination, setDestination] = useState('/public/my-room');
  const [call, setCall] = useState<Call | null>(null);

  if (call) {
    return <CallView call={call} onEnded={() => setCall(null)} />;
  }

  return (
    <main className="panel">
      <h1>SignalWire</h1>
      <p className="muted">
        {isConnected ? `Connected as ${user?.displayName ?? user?.email ?? 'subscriber'}` : 'Connecting…'}
      </p>

      {error ? <p className="error">{error.message}</p> : null}

      <input
        value={destination}
        onChange={(event) => setDestination(event.target.value)}
        placeholder="/public/my-room"
      />
      <button
        disabled={!isConnected}
        onClick={() => {
          void dial(destination, { audio: true, video: true }).then(setCall);
        }}
      >
        Call
      </button>
    </main>
  );
}

export function App(): React.JSX.Element {
  const [token, setToken] = useState<string | null>(null);

  // Memoized: a new identity tears down the client and builds a fresh one.
  const credentialProvider = useMemo<CredentialProvider | null>(
    () => (token ? { authenticate: async () => ({ token }) } : null),
    [token]
  );

  if (!credentialProvider) {
    return <TokenForm onSubmit={setToken} />;
  }

  // No `platform` prop: on the web the SDK uses browser globals directly.
  return (
    <SignalWireProvider credentialProvider={credentialProvider}>
      <Dialer />
    </SignalWireProvider>
  );
}

function TokenForm({ onSubmit }: { onSubmit: (token: string) => void }): React.JSX.Element {
  const [value, setValue] = useState('');

  return (
    <main className="panel">
      <h1>SignalWire</h1>
      <p className="muted">Paste a subscriber token to connect.</p>
      <textarea value={value} onChange={(event) => setValue(event.target.value)} rows={4} />
      <button disabled={!value.trim()} onClick={() => onSubmit(value.trim())}>
        Connect
      </button>
    </main>
  );
}
