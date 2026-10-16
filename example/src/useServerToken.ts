import { useCallback, useEffect, useState } from 'react';

import { TOKEN_URL } from './endpoints';
import { requestServerToken } from './serverToken';
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
 * to a subscriber, and says which one in `reference`. See
 * `server/src/routes/token.ts`.
 */
export type ServerTokenState =
  | { status: 'disabled' }
  | { status: 'loading' }
  | { status: 'ready'; token: string; reference: string }
  | { status: 'failed'; error: string };

export function useServerToken(): ServerTokenState & { retry: () => void } {
  const [state, setState] = useState<ServerTokenState>(
    TOKEN_URL ? { status: 'loading' } : { status: 'disabled' }
  );
  // Bumped by retry(); the request runs once per value.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!TOKEN_URL) {
      return;
    }

    let cancelled = false;
    setState({ status: 'loading' });

    // The reference is asked for explicitly, so the token and the device
    // registration agree on who this device is.
    requestServerToken(TOKEN_URL, SUBSCRIBER_REFERENCE).then(
      ({ token, reference }) => {
        if (!cancelled) {
          setState({ status: 'ready', token, reference });
        }
      },
      (error: Error) => {
        if (!cancelled) {
          // Most often the device cannot reach the host: use the machine's LAN
          // address rather than localhost, and check both are on one network.
          setState({ status: 'failed', error: error.message });
        }
      }
    );

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return { ...state, retry };
}
