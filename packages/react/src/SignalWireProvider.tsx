import { SignalWire } from '@signalwire/js';
import React, { createContext, useEffect, useMemo, useState } from 'react';
import { filter, merge } from 'rxjs';

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
   * down the client and builds a fresh one, and tearing down a client hangs
   * up every call it has in progress. To rotate a token during a call, keep
   * the same provider: return `expiry_at` from `authenticate()` and implement
   * `refresh()`, which the SDK calls before the credential expires without
   * touching the session.
   */
  credentialProvider: CredentialProvider;
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
  /** Observes call lifecycle — used by native call UI. */
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
 * The SDK's destroy() dereferences the session connect() builds, so it throws
 * before the first connect and after disconnect(), and stops before releasing
 * the transport. A client discarded while it was starting would then go on to
 * connect, register and reconnect with nobody holding it. So when destroy()
 * throws, it runs again once the client's startup has settled: it registered
 * (connected, with `skipRegister`), or it reported an error while not
 * connected. Not sooner: the startup still sends requests, and the SDK throws
 * an uncaught ReferenceError for a request made on a destroyed transport.
 */
function destroyClient(instance: SignalWire, skipRegister: boolean): void {
  try {
    instance.destroy();
    return;
  } catch (error) {
    logger.debug('Client has no session yet; destroying it once it has started:', error);
  }
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
  platform,
  observer,
  options,
  children
}: SignalWireProviderProps): React.JSX.Element {
  const [client, setClient] = useState<SignalWire | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let discarded = false;
    const ownPlatform = typeof platform === 'function' ? platform() : undefined;
    const clientPlatform = typeof platform === 'function' ? ownPlatform : platform;
    const clientOptions = { ...clientPlatform?.options, ...options };
    const instance = new SignalWire(
      whileWanted(credentialProvider, () => discarded),
      clientOptions
    );

    setClient(instance);
    setError(null);

    observer?.bindClient?.(instance);

    const subscription = instance.errors$.subscribe((next) => {
      logger.warn('SDK error:', next);
      setError(next);
    });

    return () => {
      discarded = true;
      subscription.unsubscribe();
      setClient(null);
      destroyClient(instance, clientOptions.skipRegister === true);
      // After destroy: the SDK's teardown may still touch platform globals.
      ownPlatform?.dispose();
    };
    // `platform`, `observer` and `options` are intentionally excluded:
    // rebuilding the client on every render of an inline object literal would
    // be catastrophic. Change `credentialProvider` to force a rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentialProvider]);

  // A shared platform object outlives the clients. Declared after the client
  // effect, so on unmount it is disposed after the last client is destroyed.
  useEffect(() => {
    if (!platform || typeof platform === 'function') {
      return undefined;
    }
    return () => platform.dispose();
  }, [platform]);

  const value = useMemo<SignalWireContextValue>(
    () => ({ client, error, observer }),
    [client, error, observer]
  );

  return <SignalWireContext.Provider value={value}>{children}</SignalWireContext.Provider>;
}
