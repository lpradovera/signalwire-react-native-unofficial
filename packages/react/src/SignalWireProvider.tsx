import { SignalWire } from '@signalwire/js';
import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { logger } from './logger';
import { TokenSource } from './tokenSource';

import type { FetchToken, TokenStatus } from './tokenSource';
import type { CallObserver, SignalWirePlatform } from './types';
import type { CredentialProvider, SignalWireOptions } from '@signalwire/js';

/** The SDK's errors for a lost connection, by name: it exports none of the classes. */
const CONNECTION_ERRORS = new Set([
  'WebSocketConnectionError',
  'WebSocketTimeoutError',
  'TransportConnectionError'
]);

export interface SignalWireContextValue {
  readonly client: SignalWire | null;
  readonly error: Error | null;
  readonly observer: CallObserver | undefined;
  /** The `fetchToken` source's state; `null` (or absent) with a `credentialProvider`. */
  readonly tokenStatus?: TokenStatus | null;
  /**
   * Renews the `fetchToken` token now if it is near or past its expiry, and
   * retries a failed fetch now. A no-op otherwise, and without `fetchToken`.
   * `@signalwire/react-native` calls it when a call push arrives.
   */
  readonly renewTokenIfDue?: () => void;
}

export const SignalWireContext = createContext<SignalWireContextValue | null>(null);

export interface SignalWireProviderProps {
  /**
   * Supplies authentication credentials. Memoize it — a new identity tears
   * down the client and builds a fresh one. Pass this or `fetchToken`.
   */
  credentialProvider?: CredentialProvider;
  /**
   * Fetches a token from your server: `async () => ({ token, expiresAt })`.
   * The provider connects with it, renews the token shortly before
   * `expiresAt` and when the app returns to the foreground near or past it,
   * retries failures with a backoff, and reports a 401 or 403 as
   * `useSignalWire().tokenStatus.state === 'unauthorized'` and as `error`.
   * Memoize it, as `credentialProvider`: a new identity rebuilds the client.
   * Pass this or `credentialProvider`.
   */
  fetchToken?: FetchToken;
  /**
   * Platform layer. Omit on the web: the SDK falls through to browser globals.
   * `@signalwire/react-native` supplies one automatically.
   */
  platform?: SignalWirePlatform;
  /**
   * Observes call lifecycle — used by native call UI. Its `bindClient` runs
   * for each new observer object, so memoize an observer whose `bindClient`
   * returns an unbind (an inline one is unbound and bound again on every
   * render); one that returns nothing is bound once per client.
   */
  observer?: CallObserver;
  /** Extra SDK options, merged over the platform's. */
  options?: SignalWireOptions;
  children: React.ReactNode;
}

/**
 * Owns the SignalWire client lifecycle and publishes it through context.
 *
 * Platform-agnostic by construction: it knows only the {@link SignalWirePlatform}
 * and {@link CallObserver} interfaces, so the same component drives a browser
 * app and a React Native app.
 */
export function SignalWireProvider({
  credentialProvider,
  fetchToken,
  platform,
  observer,
  options,
  children
}: SignalWireProviderProps): React.JSX.Element {
  if (!credentialProvider && !fetchToken) {
    throw new Error('SignalWireProvider needs a credentialProvider or fetchToken.');
  }
  if (credentialProvider && fetchToken) {
    throw new Error('SignalWireProvider takes a credentialProvider or fetchToken, not both.');
  }

  const [client, setClient] = useState<SignalWire | null>(null);
  const [error, setError] = useState<Error | null>(null);
  /**
   * The client an observer bound without returning an unbind (the 0.1.0
   * contract). That binding can't be undone, so it stays the client's only
   * one: binding each new observer object (an inline observer is a new one on
   * every render) would stack another subscription per render.
   */
  const boundForGood = useRef<SignalWire | null>(null);
  const [tokenStatus, setTokenStatus] = useState<TokenStatus | null>(null);
  const sourceRef = useRef<TokenSource | null>(null);

  useEffect(() => {
    // Built with the client, inside the effect, so a StrictMode remount gets
    // a fresh source instead of one its first cleanup disposed.
    const source = fetchToken ? new TokenSource(fetchToken) : null;
    sourceRef.current = source;
    const tokenSubscription = source?.status$.subscribe((status) => {
      setTokenStatus(status);
      if (status.state === 'unauthorized' && status.error) {
        setError(status.error);
      }
    });
    if (!source) {
      setTokenStatus(null);
    }
    const stopWatching = source
      ? (platform?.watchForeground ?? watchDocumentVisible)(() => source.renewIfDue())
      : undefined;

    const instance = new SignalWire(source?.credentialProvider ?? credentialProvider, {
      ...platform?.options,
      ...options
    });
    boundForGood.current = null;

    setClient(instance);
    setError(source?.status.state === 'unauthorized' ? source.status.error : null);

    const subscription = instance.errors$.subscribe((next) => {
      logger.warn('SDK error:', next);
      setError(next);
    });

    // The SDK reconnects a dropped WebSocket by itself and registers again,
    // but its connection error would stay up for the rest of the session, so
    // a banner showing it said "disconnected" while calls worked. Cleared on
    // each registration; any other error stays until the next one replaces it.
    subscription.add(
      instance.isRegistered$?.subscribe((isRegistered) => {
        if (isRegistered) {
          setError((current) => (current && CONNECTION_ERRORS.has(current.name) ? null : current));
        }
      })
    );

    return () => {
      subscription.unsubscribe();
      tokenSubscription?.unsubscribe();
      stopWatching?.();
      source?.dispose();
      if (sourceRef.current === source) {
        sourceRef.current = null;
      }
      setClient(null);
      try {
        instance.destroy();
      } catch (destroyError) {
        logger.warn('Client destroy threw:', destroyError);
      }
      // After destroy: the SDK's teardown may still touch platform globals.
      platform?.dispose();
    };
    // `platform`, `observer` and `options` are intentionally excluded:
    // rebuilding the client on every render of an inline object literal would
    // be catastrophic. Change `credentialProvider` or `fetchToken` to force a
    // rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentialProvider, fetchToken]);

  const renewTokenIfDue = useCallback(() => sourceRef.current?.renewIfDue(), []);

  // Bound here, not where the client is built: the observer can arrive or
  // change later (React Native builds its CallKit observer only once callKit
  // is turned on, and drops it when callKit is turned off). The unbind it
  // returns runs when it changes or goes away, or the client is replaced, so
  // a dropped observer stops handling the client's calls. An observer that
  // returns no unbind is bound once per client, as in 0.1.0.
  useEffect(() => {
    if (!client || boundForGood.current === client || !observer?.bindClient) {
      return undefined;
    }
    const unbind = observer.bindClient(client);
    if (typeof unbind === 'function') {
      return unbind;
    }
    boundForGood.current = client;
    return undefined;
  }, [client, observer]);

  const value = useMemo<SignalWireContextValue>(
    () => ({ client, error, observer, tokenStatus, renewTokenIfDue }),
    [client, error, observer, tokenStatus, renewTokenIfDue]
  );

  return <SignalWireContext.Provider value={value}>{children}</SignalWireContext.Provider>;
}

/** The browser's foreground signal, for platforms without `watchForeground`. */
function watchDocumentVisible(listener: () => void): () => void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc || typeof doc.addEventListener !== 'function') {
    return () => undefined;
  }
  const onChange = (): void => {
    if (doc.visibilityState !== 'hidden') {
      listener();
    }
  };
  doc.addEventListener('visibilitychange', onChange);
  return () => doc.removeEventListener('visibilitychange', onChange);
}
