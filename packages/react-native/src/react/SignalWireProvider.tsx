import { SignalWireProvider as CoreProvider } from '@signalwire/react';
import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react';

import { createCallKitObserver } from '../callkit/observer';
import { createReactNativePlatform } from '../platform/createReactNativePlatform';
import { PushWakeRenewal } from './PushWakeRenewal';

import type { CallKitObserverOptions } from '../callkit/observer';
import type { ReactNativePlatformOptions } from '../platform/createReactNativePlatform';
import type { CallObserver, FetchToken } from '@signalwire/react';
import type { CredentialProvider, SignalWireOptions } from '@signalwire/js';

export interface SignalWireProviderProps {
  /**
   * Supplies authentication credentials. Memoize it — a new identity tears
   * down the client and builds a fresh one. Pass this or `fetchToken`.
   */
  credentialProvider?: CredentialProvider;
  /**
   * Fetches a token from your server: `async () => ({ token, expiresAt })`.
   * The client connects with it, renews it shortly before `expiresAt`, when
   * the app returns to the foreground and when a call push arrives with the
   * token near or past its expiry, retries failures with a backoff, and
   * reports a 401 or 403 through `useSignalWire().tokenStatus` and `error`.
   * Memoize it: a new identity rebuilds the client. Pass this or
   * `credentialProvider`.
   */
  fetchToken?: FetchToken;
  /** React Native platform options (NetInfo and AppState shims). */
  platform?: ReactNativePlatformOptions;
  /** Extra SDK options, merged over the platform defaults. */
  options?: SignalWireOptions;
  /**
   * Route calls through the native call UI (CallKit / ConnectionService).
   * Requires callkeep (`@signalwire/react-native-callkeep`, or stock
   * `react-native-callkeep`), and
   * `getCallKit().setup(...)` to have been called from your app entry. Pass
   * options instead of `true` to name outbound calls in the native UI.
   */
  callKit?: boolean | CallKitObserverOptions;
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
  fetchToken,
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

  // Built once, like the platform: an inline options object must not rebuild
  // it. The observer reads the options through this ref instead, so a changed
  // `displayName` takes effect on the next call.
  const callKitOptions = useRef<CallKitObserverOptions>({});
  useLayoutEffect(() => {
    callKitOptions.current = typeof callKit === 'object' ? callKit : {};
  });
  const callKitOn = Boolean(callKit);
  const observer = useMemo<CallObserver | undefined>(
    () => (callKitOn ? createCallKitObserver(() => callKitOptions.current) : undefined),
    [callKitOn]
  );

  return (
    <CoreProvider
      credentialProvider={credentialProvider}
      fetchToken={fetchToken}
      platform={platformFactory}
      observer={observer}
      options={options}
    >
      {fetchToken && callKitOn ? <PushWakeRenewal /> : null}
      {children}
    </CoreProvider>
  );
}
