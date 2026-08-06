import { SignalWireProvider, useSignalWire } from '@signalwire/react';
import React, { useEffect, useMemo, useState } from 'react';

import { CallView } from './CallView';

import type { Call, CredentialProvider } from '@signalwire/js';

function Dialer(): React.JSX.Element {
  const { isConnected, user, dial, error } = useSignalWire();
  const [destination, setDestination] = useState('/private/hello-world');
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
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(true);

  // Fetch a subscriber token from the support server on load, mirroring the
  // React Native example. Proxied by Vite (see vite.config.ts) so this is
  // same-origin and needs no CORS headers on the token server.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch('/token', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({})
        });
        const body = (await response.json()) as { token?: string; error?: string };
        if (cancelled) {
          return;
        }
        if (!response.ok || !body.token) {
          setFetchError(body.error ?? `Token server returned ${response.status}`);
        } else {
          setToken(body.token);
        }
      } catch (error) {
        if (!cancelled) {
          setFetchError((error as Error).message);
        }
      } finally {
        if (!cancelled) {
          setFetching(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Memoized: a new identity tears down the client and builds a fresh one.
  const credentialProvider = useMemo<CredentialProvider | null>(
    () => (token ? { authenticate: async () => ({ token }) } : null),
    [token]
  );

  if (!credentialProvider) {
    return <TokenForm onSubmit={setToken} fetching={fetching} fetchError={fetchError} />;
  }

  // No `platform` prop: on the web the SDK uses browser globals directly.
  return (
    <SignalWireProvider credentialProvider={credentialProvider}>
      <Dialer />
    </SignalWireProvider>
  );
}

function TokenForm({
  onSubmit,
  fetching,
  fetchError
}: {
  onSubmit: (token: string) => void;
  fetching?: boolean;
  fetchError?: string | null;
}): React.JSX.Element {
  const [value, setValue] = useState('');

  if (fetching) {
    return (
      <main className="panel">
        <h1>SignalWire</h1>
        <p className="muted">Requesting a token from the server…</p>
      </main>
    );
  }

  return (
    <main className="panel">
      <h1>SignalWire</h1>
      {fetchError ? <p className="muted">Token server: {fetchError}</p> : null}
      <p className="muted">Paste a subscriber token to connect.</p>
      <textarea value={value} onChange={(event) => setValue(event.target.value)} rows={4} />
      <button disabled={!value.trim()} onClick={() => onSubmit(value.trim())}>
        Connect
      </button>
    </main>
  );
}
