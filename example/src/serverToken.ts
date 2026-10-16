import { TokenFetchError } from '@signalwire/react-native';

import { TOKEN_URL } from './endpoints';
import { SUBSCRIBER_REFERENCE } from './subscriber';

import type { FetchedToken } from '@signalwire/react-native';

/**
 * The provider's `fetchToken`: a subscriber token from the support server.
 *
 * Set `EXPO_PUBLIC_SW_TOKEN_URL` to the server's `/token` endpoint — the
 * `EXPO_PUBLIC_` prefix is what makes Expo inline the value into the bundle, so
 * renaming it breaks this silently. Unset, the app falls back to the paste-a-
 * token screen, which is still the quickest path when you have a token to hand.
 *
 * The provider calls this to connect, again before each token's `expires_at`,
 * and on foreground or a call push when it is due; it retries failures itself.
 * A 401 or 403 is thrown with its status, so it shows as 'unauthorized'
 * instead of being retried. Module scope: a new function identity would
 * rebuild the client.
 *
 * Real deployments send their own session credential here; the server maps it
 * to a subscriber. See `server/src/routes/token.ts`.
 */
const url = TOKEN_URL;

export const fetchServerToken = url
  ? async (): Promise<FetchedToken> => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Named explicitly, so the token and the device registration
        // agree on who this device is.
        body: JSON.stringify({ reference: SUBSCRIBER_REFERENCE })
      });
      const body = (await response.json().catch(() => ({}))) as {
        token?: string;
        expires_at?: number;
        error?: string;
      };
      if (!response.ok || !body.token) {
        throw new TokenFetchError(body.error ?? `Token server returned ${response.status}`, {
          status: response.status
        });
      }
      return { token: body.token, expiresAt: body.expires_at };
    }
  : undefined;
