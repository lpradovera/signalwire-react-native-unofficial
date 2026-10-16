import { SignalWireProvider as CoreProvider } from '@signalwire/react';
import React, { useCallback, useMemo } from 'react';

import { createCallKitObserver } from '../callkit/observer';
import { createReactNativePlatform } from '../platform/createReactNativePlatform';

import type { ReactNativePlatformOptions } from '../platform/createReactNativePlatform';
import type { CallObserver } from '@signalwire/react';
import type { CredentialProvider, SignalWireOptions } from '@signalwire/js';

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

/**
 * React Native flavour of `SignalWireProvider`.
 *
 * Identical API to the web, because it supplies the platform layer itself
 * rather than making callers pass one. Forgetting that argument would surface
 * as the polyfill error chain, which is a poor way to learn about it.
 */
export function SignalWireProvider({
  credentialProvider,
  platform,
  options,
  callKit = false,
  children
}: SignalWireProviderProps): React.JSX.Element {
  // One platform per client, built by the core provider when it builds the
  // client and disposed after that client is destroyed: dispose() removes the
  // NetInfo and AppState shims for good, so a platform shared by the next
  // client (a new credentialProvider, or React.StrictMode's remount) would
  // leave that client deaf to network and foreground changes. The factory's
  // identity is stable and `platform` is read once, as before.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const platformFactory = useCallback(() => createReactNativePlatform(platform), []);

  const observer = useMemo<CallObserver | undefined>(
    () => (callKit ? createCallKitObserver() : undefined),
    [callKit]
  );

  return (
    <CoreProvider
      credentialProvider={credentialProvider}
      platform={platformFactory}
      observer={observer}
      options={options}
    >
      {children}
    </CoreProvider>
  );
}
