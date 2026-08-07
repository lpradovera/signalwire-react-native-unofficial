import { useEffect, useState } from 'react';

import { SUBSCRIBER_REFERENCE } from './subscriber';

/**
 * Fetches a subscriber token from the support server on launch.
 *
 * Set `EXPO_PUBLIC_SW_TOKEN_URL` to the server's `/token` endpoint — the
 * `EXPO_PUBLIC_` prefix is what makes Expo inline the value into the bundle, so
 * renaming it breaks this silently. Unset, the app falls back to the paste-a-
 * token screen, which is still the quickest path when you have a token to hand.
 *
 * Real deployments send their own session credential here; the server maps it
 * to a subscriber. See `server/src/routes/token.ts`.
 */
export type ServerTokenState =
  | { status: 'disabled' }
  | { status: 'loading' }
  | { status: 'ready'; token: string }
  | { status: 'failed'; error: string };

const TOKEN_URL = process.env.EXPO_PUBLIC_SW_TOKEN_URL;

export function useServerToken(): ServerTokenState {
  const [state, setState] = useState<ServerTokenState>(
    TOKEN_URL ? { status: 'loading' } : { status: 'disabled' }
  );

  useEffect(() => {
    if (!TOKEN_URL) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Named explicitly, so the token and the device registration
          // agree on who this device is.
          body: JSON.stringify({ reference: SUBSCRIBER_REFERENCE })
        });

        const body = (await response.json()) as { token?: string; error?: string };

        if (cancelled) {
          return;
        }
        if (!response.ok || !body.token) {
          setState({
            status: 'failed',
            error: body.error ?? `Token server returned ${response.status}`
          });
          return;
        }
        setState({ status: 'ready', token: body.token });
      } catch (error) {
        if (!cancelled) {
          // Most often the device cannot reach the host: use the machine's LAN
          // address rather than localhost, and check both are on one network.
          setState({ status: 'failed', error: (error as Error).message });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
