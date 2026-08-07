import { SignalWireProvider, useSignalWire } from '@signalwire/react';
import React, { useEffect, useMemo, useState } from 'react';

import { CallView } from './CallView';

import type { Call, CredentialProvider } from '@signalwire/js';

/**
 * Acquires the microphone before dialling, so a permission problem reports
 * itself as one.
 *
 * The SDK takes local media before it sends the invite. If the browser is
 * sitting on an unanswered permission prompt, getUserMedia never settles, the
 * invite never goes out, and the only symptom is the SDK's own 10s
 * "Call create timeout" — which points at the network, at SignalWire, or at
 * the destination address, all of which are fine. Asking first turns an
 * invisible browser prompt into a message that names the actual cause.
 */
async function ensureMicrophone(): Promise<void> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (error) {
    const name = (error as DOMException).name;
    throw new Error(
      name === 'NotAllowedError'
        ? 'Microphone permission denied. Allow it for this site, then call again.'
        : `Could not open the microphone (${name}).`
    );
  }
  // Released immediately: this was a permission check, and the SDK opens its
  // own stream. Holding this one would leave the recording indicator on.
  stream.getTracks().forEach((track) => track.stop());
}

function Dialer(): React.JSX.Element {
  const { isConnected, user, dial, error } = useSignalWire();
  const [dialError, setDialError] = useState<string | null>(null);
  const [destination, setDestination] = useState('/public/rn-example-park');
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
      {dialError ? <p className="error">Dial failed: {dialError}</p> : null}

      <input
        value={destination}
        onChange={(event) => setDestination(event.target.value)}
        placeholder="/public/my-room"
      />
      <button
        disabled={!isConnected}
        onClick={() => {
          setDialError(null);
          void ensureMicrophone()
            .then(() => dial(destination, { audio: true, video: false }))
            .then(setCall)
            .catch((dialFailure: Error) => setDialError(dialFailure.message));
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
          // A distinct reference: the browser must be a different subscriber from the
          // iPad, or we would be calling ourselves.
          body: JSON.stringify({ reference: 'web-caller' })
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
