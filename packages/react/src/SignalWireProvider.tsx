import { SignalWire } from '@signalwire/js';
import React, { createContext, useEffect, useMemo, useRef, useState } from 'react';

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
  platform,
  observer,
  options,
  children
}: SignalWireProviderProps): React.JSX.Element {
  const [client, setClient] = useState<SignalWire | null>(null);
  const [error, setError] = useState<Error | null>(null);
  /**
   * The client an observer bound without returning an unbind (the 0.1.0
   * contract). That binding can't be undone, so it stays the client's only
   * one: binding each new observer object (an inline observer is a new one on
   * every render) would stack another subscription per render.
   */
  const boundForGood = useRef<SignalWire | null>(null);

  useEffect(() => {
    const instance = new SignalWire(credentialProvider, {
      ...platform?.options,
      ...options
    });
    boundForGood.current = null;

    setClient(instance);
    setError(null);

    const subscription = instance.errors$.subscribe((next) => {
      logger.warn('SDK error:', next);
      setError(next);
    });

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
    () => ({ client, error, observer }),
    [client, error, observer]
  );

  return <SignalWireContext.Provider value={value}>{children}</SignalWireContext.Provider>;
}
