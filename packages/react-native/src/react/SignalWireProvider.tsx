import { SignalWire } from '@signalwire/js';
import React, { createContext, useEffect, useMemo, useState } from 'react';

import { loadCallKit } from '../callkit/lazy';
import { logger } from '../logger';
import { createReactNativePlatform } from '../platform/createReactNativePlatform';

import type { ReactNativePlatformOptions } from '../platform/createReactNativePlatform';
import type { CredentialProvider, SignalWireOptions } from '@signalwire/js';

export interface SignalWireContextValue {
  readonly client: SignalWire | null;
  readonly error: Error | null;
  readonly callKitEnabled: boolean;
}

export const SignalWireContext = createContext<SignalWireContextValue | null>(null);

export interface SignalWireProviderProps {
  /**
   * Supplies authentication credentials. Memoize it — a new identity tears
   * down the client and builds a fresh one.
   */
  credentialProvider: CredentialProvider;
  /** React Native platform options (NetInfo and AppState shims). */
  platform?: ReactNativePlatformOptions;
  /** Extra SDK options, merged over the platform defaults. */
  options?: SignalWireOptions;
  /**
   * Route calls through the native call UI (CallKit / ConnectionService).
   * Requires the optional peer `react-native-callkeep`, and
   * `getCallKit().setup(...)` to have been called from your app entry.
   */
  callKit?: boolean;
  children: React.ReactNode;
}

/** Owns the SignalWire client lifecycle and publishes it through context. */
export function SignalWireProvider({
  credentialProvider,
  platform,
  options,
  callKit = false,
  children
}: SignalWireProviderProps): React.JSX.Element {
  const [client, setClient] = useState<SignalWire | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const rnPlatform = createReactNativePlatform(platform);
    const instance = new SignalWire(credentialProvider, {
      ...rnPlatform.options,
      ...options
    });

    setClient(instance);
    setError(null);

    if (callKit) {
      loadCallKit().bindClient(instance);
    }

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
      rnPlatform.dispose();
    };
    // `platform` and `options` are intentionally not dependencies: rebuilding
    // the client on every render of an inline object literal would be
    // catastrophic. Change `credentialProvider` to force a rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentialProvider, callKit]);

  const value = useMemo<SignalWireContextValue>(
    () => ({ client, error, callKitEnabled: callKit }),
    [client, error, callKit]
  );

  return <SignalWireContext.Provider value={value}>{children}</SignalWireContext.Provider>;
}
