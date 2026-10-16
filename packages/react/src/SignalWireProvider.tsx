import { SignalWire } from '@signalwire/js';
import React, { createContext, useEffect, useMemo, useState } from 'react';

import { logger } from './logger';

import type { CallObserver, SignalWirePlatform } from './types';
import type { CredentialProvider, SignalWireOptions } from '@signalwire/js';

export interface SignalWireContextValue {
  readonly client: SignalWire | null;
  readonly error: Error | null;
  readonly observer: CallObserver | undefined;
}

export const SignalWireContext = createContext<SignalWireContextValue | null>(null);

export interface SignalWireProviderProps {
  /**
   * Supplies authentication credentials. Memoize it — a new identity tears
   * down the client and builds a fresh one.
   */
  credentialProvider: CredentialProvider;
  /**
   * Platform layer. Omit on the web: the SDK falls through to browser globals.
   * `@signalwire/react-native` supplies one automatically.
   */
  platform?: SignalWirePlatform;
  /** Observes call lifecycle — used by native call UI. */
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
  platform,
  observer,
  options,
  children
}: SignalWireProviderProps): React.JSX.Element {
  const [client, setClient] = useState<SignalWire | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const instance = new SignalWire(credentialProvider, {
      ...platform?.options,
      ...options
    });

    setClient(instance);
    setError(null);

    observer?.bindClient?.(instance);

    const subscription = instance.errors$.subscribe((next) => {
      logger.warn('SDK error:', next);
      setError(next);
    });

    // `error` is the last error since the client was last ready. The SDK
    // reports transient failures on errors$ (each WebSocket 'error' event, a
    // connect timeout, a register retry) and then reconnects by itself;
    // isConnected$ stays true through that, so readiness (connected and
    // authenticated again) is what says the failure is over. Kept, the first
    // of them showed as a current failure for the rest of the session.
    // Optional: a client double without ready$ just keeps its last error.
    const ready$ = (instance as { ready$?: SignalWire['ready$'] }).ready$;
    if (ready$) {
      subscription.add(
        ready$.subscribe((ready) => {
          if (ready) {
            setError(null);
          }
        })
      );
    }

    return () => {
      subscription.unsubscribe();
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
    // be catastrophic. Change `credentialProvider` to force a rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentialProvider]);

  const value = useMemo<SignalWireContextValue>(
    () => ({ client, error, observer }),
    [client, error, observer]
  );

  return <SignalWireContext.Provider value={value}>{children}</SignalWireContext.Provider>;
}
