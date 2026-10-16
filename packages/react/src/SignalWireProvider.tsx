import { SignalWire } from '@signalwire/js';
import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { filter, merge } from 'rxjs';

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

/**
 * The SDK's error for a call it could not place or set up. It is thrown to the
 * caller as well, so it says nothing about the client once a later call works.
 */
const CALL_ERRORS = new Set(['CallCreateError']);

/** Whether `error` is about one call rather than the client. */
function isCallError(error: Error | null): boolean {
  return error !== null && CALL_ERRORS.has(error.name);
}

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
  /**
   * Clears `error` if it is a call error (`CallCreateError`). `useSignalWire`
   * calls it when a dial succeeds; the provider itself when the client
   * registers again.
   */
  readonly clearCallError?: () => void;
}

export const SignalWireContext = createContext<SignalWireContextValue | null>(null);

export interface SignalWireProviderProps {
  /**
   * Supplies authentication credentials. Memoize it — a new identity tears
   * down the client and builds a fresh one, and tearing down a client hangs
   * up every call it has in progress. To rotate a token during a call, keep
   * the same provider: return `expiry_at` from `authenticate()` and implement
   * `refresh()`, which the SDK calls before the credential expires without
   * touching the session. Pass this or `fetchToken`.
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
   *
   * A function builds one platform per client: it is called for each client
   * the provider builds, and that platform is disposed after the client is
   * destroyed. A platform object is shared by every client and disposed when
   * the provider unmounts or gets another platform; React.StrictMode's
   * simulated unmount disposes it too, so pass a function for a platform
   * that cannot be used after dispose().
   */
  platform?: SignalWirePlatform | (() => SignalWirePlatform);
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

/** A promise that never settles: parks whatever awaits it. */
const never = <T,>(): Promise<T> => new Promise<T>(() => undefined);

/**
 * Hands the client credentials only while it is wanted. A discarded client's
 * startup (the constructor's resolveCredentials().then(init) chain) is still
 * running and cannot be cancelled; parked here, it never gets as far as
 * connecting. `this` stays the app's provider.
 */
function whileWanted(provider: CredentialProvider, discarded: () => boolean): CredentialProvider {
  const gate = async <T,>(run: () => Promise<T>): Promise<T> => {
    if (discarded()) return never<T>();
    const value = await run();
    return discarded() ? never<T>() : value;
  };
  const gated: CredentialProvider = {
    authenticate: (context) => gate(() => provider.authenticate(context))
  };
  if (provider.refresh) {
    gated.refresh = (...args) => gate(() => provider.refresh!(...args));
  }
  return gated;
}

/**
 * Tears a client down, now or as soon as it can be.
 *
 * A client discarded while it was starting would go on to connect, register
 * and reconnect with nobody holding it: its startup (the constructor's
 * resolveCredentials().then(init) chain) cannot be cancelled. @signalwire/js
 * 4.0.0-rc.2's destroy() throws there, since it dereferences the session
 * connect() builds; rc.5's returns, but the startup still connects
 * afterwards. So a client without a session yet is destroyed once its startup
 * has settled: it registered (connected, with `skipRegister`), or it reported
 * an error while not connected. Not sooner: the startup still sends requests,
 * and the SDK throws an uncaught ReferenceError for a request made on a
 * destroyed transport.
 */
function destroyClient(instance: SignalWire, skipRegister: boolean): void {
  if (instance.session) {
    try {
      instance.destroy();
    } catch (destroyError) {
      logger.warn('Client destroy threw:', destroyError);
    }
    return;
  }
  logger.debug('Client has no session yet; destroying it once it has started');
  const started$ = skipRegister ? instance.isConnected$ : instance.isRegistered$;
  let done = false;
  const retry = merge(
    started$.pipe(filter(Boolean)),
    instance.errors$.pipe(filter(() => !instance.isConnected))
  ).subscribe(() => {
    if (done || !instance.session) return;
    done = true;
    try {
      instance.destroy();
    } catch (destroyError) {
      logger.warn('Client destroy threw:', destroyError);
    }
    retry.unsubscribe();
  });
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
    let discarded = false;
    const ownPlatform = typeof platform === 'function' ? platform() : undefined;
    const clientPlatform = typeof platform === 'function' ? ownPlatform : platform;
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
      ? (clientPlatform?.watchForeground ?? watchDocumentVisible)(() => source.renewIfDue())
      : undefined;

    const clientOptions = { ...clientPlatform?.options, ...options };
    // One of the two is set: checked above.
    const credentials = (source?.credentialProvider ?? credentialProvider) as CredentialProvider;
    const instance = new SignalWire(
      whileWanted(credentials, () => discarded),
      clientOptions
    );
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
    // each registration, as is a failed call's error (a connect starts over);
    // any other error stays until the next one replaces it.
    subscription.add(
      instance.isRegistered$?.subscribe((isRegistered) => {
        if (isRegistered) {
          setError((current) =>
            current && (CONNECTION_ERRORS.has(current.name) || isCallError(current)) ? null : current
          );
        }
      })
    );

    return () => {
      discarded = true;
      subscription.unsubscribe();
      tokenSubscription?.unsubscribe();
      stopWatching?.();
      source?.dispose();
      if (sourceRef.current === source) {
        sourceRef.current = null;
      }
      setClient(null);
      destroyClient(instance, clientOptions.skipRegister === true);
      // After destroy: the SDK's teardown may still touch platform globals.
      ownPlatform?.dispose();
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

  // A shared platform object outlives the clients. Declared after the client
  // effect, so on unmount it is disposed after the last client is destroyed.
  useEffect(() => {
    if (!platform || typeof platform === 'function') {
      return undefined;
    }
    return () => platform.dispose();
  }, [platform]);

  const clearCallError = useCallback(() => {
    setError((current) => (isCallError(current) ? null : current));
  }, []);

  const value = useMemo<SignalWireContextValue>(
    () => ({ client, error, observer, tokenStatus, renewTokenIfDue, clearCallError }),
    [client, error, observer, tokenStatus, renewTokenIfDue, clearCallError]
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
