import { TokenFetchError } from '@signalwire/react-native';
import { useSyncExternalStore } from 'react';

import { TOKEN_URL } from './endpoints';
import { requestServerToken, ServerTokenError } from './serverToken';
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
 * A refusal is thrown as a TokenFetchError with its status, so a 401 or 403
 * shows as 'unauthorized' instead of being retried. Module scope: a new
 * function identity would rebuild the client.
 *
 * Real deployments send their own session credential here; the server maps it
 * to a subscriber. See `server/src/routes/token.ts`.
 */
const url = TOKEN_URL;

export const fetchServerToken = url
  ? async (): Promise<FetchedToken> => {
      try {
        const answer = await requestServerToken(url, SUBSCRIBER_REFERENCE);
        setServerReference(answer.reference);
        return { token: answer.token, expiresAt: answer.expiresAt };
      } catch (error) {
        if (error instanceof ServerTokenError) {
          throw new TokenFetchError(error.message, { status: error.status });
        }
        throw error;
      }
    }
  : undefined;

/**
 * The subscriber the server minted the current token for. The device registers
 * for push under exactly that one: the server decides whose token it is.
 */
let serverReference: string | undefined;
const listeners = new Set<() => void>();

function setServerReference(reference: string): void {
  if (reference === serverReference) {
    return;
  }
  serverReference = reference;
  for (const listener of listeners) {
    listener();
  }
}

/**
 * {@link serverReference}, as React state: undefined until the first token,
 * which device registration waits for (it is not "no reference").
 */
export function useServerReference(): string | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => serverReference
  );
}
