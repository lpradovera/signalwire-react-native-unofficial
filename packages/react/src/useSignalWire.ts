import { useCallback, useContext } from 'react';

import { SignalWireContext } from './SignalWireProvider';
import { useObservable } from './useObservable';

import type { SignalWireContextValue } from './SignalWireProvider';
import type { TokenStatus } from './tokenSource';
import type { Call, DialOptions, Directory, SignalWire, User } from '@signalwire/js';

export interface UseSignalWireResult {
  readonly client: SignalWire | null;
  readonly isConnected: boolean;
  readonly isRegistered: boolean;
  readonly user: User | undefined;
  readonly directory: Directory | undefined;
  readonly error: Error | null;
  /**
   * The `fetchToken` source's state: `'fetching'`, `'ready'`, `'renewing'`,
   * `'retrying'` (with the `error`) or `'unauthorized'`. `null` when the
   * provider was given a `credentialProvider`.
   */
  readonly tokenStatus: TokenStatus | null;
  dial(destination: string, options?: DialOptions): Promise<Call>;
  /**
   * Connects the client again after {@link disconnect}, and registers it for
   * inbound calls, as its startup does. The SDK does not reconnect after an
   * explicit disconnect, and the provider rebuilds the client only for a new
   * credentialProvider. (With the `skipRegister` option, call
   * `client.connect()` instead.)
   */
  connect(): Promise<void>;
  /** Closes the connection; the client stays disconnected until {@link connect}. */
  disconnect(): Promise<void>;
}

function useSignalWireContext(): SignalWireContextValue {
  const context = useContext(SignalWireContext);
  if (!context) {
    throw new Error(
      'useSignalWire must be used inside a <SignalWireProvider>. ' +
        'Wrap your app root with <SignalWireProvider credentialProvider={...}>.'
    );
  }
  return context;
}

/** Client-level state and actions. */
export function useSignalWire(): UseSignalWireResult {
  const { client, error, observer, tokenStatus = null } = useSignalWireContext();

  const isConnected = useObservable(client?.isConnected$, client?.isConnected ?? false);
  const isRegistered = useObservable(client?.isRegistered$, client?.isRegistered ?? false);
  const user = useObservable(client?.user$, client?.user);
  const directory = useObservable(client?.directory$, client?.directory);

  const dial = useCallback(
    async (destination: string, options?: DialOptions): Promise<Call> => {
      if (!client) {
        throw new Error('SignalWire client is not ready yet.');
      }
      // May throw to refuse the dial (a call already in progress on React
      // Native): nothing has been placed yet.
      observer?.beforeOutgoingCall?.(destination);
      const call = await client.dial(destination, options);
      // The core does not know what an observer does with this — on React
      // Native it registers the call with CallKit; on the web nobody listens.
      observer?.onOutgoingCall?.(call, destination);
      return call;
    },
    [client, observer]
  );

  const connect = useCallback(async (): Promise<void> => {
    if (!client) {
      return;
    }
    await client.connect();
    await client.register();
  }, [client]);

  const disconnect = useCallback((): Promise<void> => {
    if (!client) {
      return Promise.resolve();
    }
    return client.disconnect();
  }, [client]);

  return { client, isConnected, isRegistered, user, directory, error, tokenStatus, dial, connect, disconnect };
}
