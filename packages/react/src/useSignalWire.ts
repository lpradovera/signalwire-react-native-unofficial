import { useCallback, useContext } from 'react';

import { holdOtherCalls, resumeCalls } from './liveCalls';
import { SignalWireContext } from './SignalWireProvider';
import { useObservable } from './useObservable';

import type { SignalWireContextValue } from './SignalWireProvider';
import type { TokenStatus } from './tokenSource';
import type { Call, DialOptions, Directory, SignalWire, User } from '@signalwire/js';

/** Call statuses past which a hangup has nothing left to end. */
const ENDING_STATUSES: ReadonlySet<string> = new Set([
  'disconnecting',
  'disconnected',
  'destroyed',
  'failed'
]);

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
  /**
   * Places a call. A call already in progress is put on hold first (and
   * taken off hold again if this one cannot be placed). On React Native the
   * native call UI may refuse a second call; see `callWaiting`.
   */
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
  const { client, error, observer, tokenStatus = null, clearCallError } = useSignalWireContext();

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
      // Call waiting: the call in progress is put on hold first, so only the
      // new call has live media; it is resumed if the new call is not placed.
      const held = await holdOtherCalls(client, observer);
      let call: Call;
      try {
        call = await client.dial(destination, options);
      } catch (error) {
        await resumeCalls(held, observer);
        throw error;
      }
      // The core does not know what an observer does with this — on React
      // Native it registers the call with CallKit; on the web nobody listens.
      try {
        observer?.onOutgoingCall?.(call, destination);
      } catch (error) {
        // dial() rejects, so the app never gets this call to hang up: end it
        // here, or its leg stays up on SignalWire. An observer that ended it
        // already (a refused second call) is left to finish its own bye.
        if (!ENDING_STATUSES.has(call.status)) {
          void call.hangup().catch(() => undefined);
        }
        await resumeCalls(held, observer);
        throw error;
      }
      // A call is up: an earlier failed dial's error no longer says anything.
      clearCallError?.();
      return call;
    },
    [client, observer, clearCallError]
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
