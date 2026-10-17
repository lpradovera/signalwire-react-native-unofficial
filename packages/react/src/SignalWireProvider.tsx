import { SignalWire } from '@signalwire/js';
import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { filter, firstValueFrom, merge, of, startWith, switchMap } from 'rxjs';

import { logger } from './logger';
import { TokenSource } from './tokenSource';

import type { FetchToken, TokenStatus } from './tokenSource';
import type { CallObserver, SignalWirePlatform } from './types';
import type { CredentialProvider, SignalWireOptions } from '@signalwire/js';
import type { Observable, Subscription } from 'rxjs';

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
  /**
   * Keep the client, and its calls, when the provider unmounts while a call
   * is in progress, instead of hanging the calls up. The next provider to
   * mount takes that client back, calls and all; once its calls have ended
   * with no provider mounted, it is torn down as usual. For React Native,
   * where Back on Android destroys the activity and unmounts the app while
   * the call goes on (`@signalwire/react-native` turns it on with native
   * call UI). Default `false`: unmounting ends the calls.
   */
  keepCallsOnUnmount?: boolean;
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

/** Statuses after which a call has nothing left to send. */
const ENDED_STATUSES = new Set(['disconnected', 'failed', 'destroyed']);
/** How long teardown waits for live calls' byes before destroying the client anyway. */
const HANGUP_ON_TEARDOWN_MS = 4000;

interface TeardownCall {
  readonly status?: string;
  readonly status$?: Observable<string>;
  hangup(): Promise<unknown>;
}

/**
 * Ends the client's live calls and resolves when each has (or after
 * {@link HANGUP_ON_TEARDOWN_MS}). A call already hanging up is waited for,
 * not hung up again. Resolves at once when there is no live call.
 */
function endLiveCalls(instance: SignalWire): Promise<void> | null {
  const calls = ((instance.session as { calls?: TeardownCall[] } | undefined)?.calls ?? []).filter(
    (call) => typeof call?.status === 'string' && !ENDED_STATUSES.has(call.status)
  );
  if (calls.length === 0) {
    return null;
  }
  logger.info(`Ending ${calls.length} live call(s) before tearing the client down`);
  const ended = calls.map((call) => {
    if (call.status === 'disconnecting' && call.status$) {
      return firstValueFrom(call.status$.pipe(filter((status) => ENDED_STATUSES.has(status)))).catch(
        () => undefined
      );
    }
    return call.hangup().catch((error: unknown) => logger.debug('Hangup on teardown failed:', error));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((done) => {
    timer = setTimeout(() => {
      logger.warn('Live calls did not end in time; tearing the client down anyway');
      done();
    }, HANGUP_ON_TEARDOWN_MS);
  });
  return Promise.race([Promise.all(ended).then(() => undefined), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Tears the client down after its live calls have ended, then runs `after`.
 *
 * Destroying the client closes its socket, so a call still up could no longer
 * send its bye and would stay up on SignalWire: on React Native, Back on the
 * root screen destroys the activity, which unmounts this provider mid-call.
 */
function teardownClient(instance: SignalWire, skipRegister: boolean, after: () => void): Promise<void> | null {
  const ending = endLiveCalls(instance);
  if (!ending) {
    destroyClient(instance, skipRegister);
    after();
    return null;
  }
  return ending.then(() => {
    destroyClient(instance, skipRegister);
    after();
  });
}

/** A client and what was built with it, torn down together. */
interface ClientBundle {
  readonly instance: SignalWire;
  readonly source: TokenSource | null;
  /** The platform built for this client (a factory's), disposed with it. */
  readonly ownPlatform: SignalWirePlatform | undefined;
  readonly clientPlatform: SignalWirePlatform | undefined;
  readonly skipRegister: boolean;
  /** Set once the client is torn down; parks its startup (see whileWanted). */
  discarded: boolean;
  /** Observer unbinds held while the client is kept; see keepClient. */
  readonly unbinds: Array<() => void>;
  /** Watches a kept client's calls; see keepClient. */
  watch: Subscription | null;
}

function buildClient(
  platform: SignalWirePlatform | (() => SignalWirePlatform) | undefined,
  fetchToken: FetchToken | undefined,
  credentialProvider: CredentialProvider | undefined,
  options: SignalWireOptions | undefined
): ClientBundle {
  const ownPlatform = typeof platform === 'function' ? platform() : undefined;
  const clientPlatform = typeof platform === 'function' ? ownPlatform : platform;
  // Built with the client, inside the effect, so a StrictMode remount gets
  // a fresh source instead of one its first cleanup disposed.
  const source = fetchToken ? new TokenSource(fetchToken) : null;
  const clientOptions = { ...clientPlatform?.options, ...options };
  // One of the two is set: the provider checks.
  const credentials = (source?.credentialProvider ?? credentialProvider) as CredentialProvider;
  // The startup gate reads `discarded` from the bundle the client ends up in.
  const state = { discarded: false };
  const instance = new SignalWire(
    whileWanted(credentials, () => state.discarded),
    clientOptions
  );
  const bundle: ClientBundle = Object.assign(state, {
    instance,
    source,
    ownPlatform,
    clientPlatform,
    skipRegister: clientOptions.skipRegister === true,
    unbinds: [],
    watch: null
  });
  return bundle;
}

/** Ends the client's calls, then destroys it and what was built with it. */
function retireClient(bundle: ClientBundle, teardowns: Set<Promise<void>>): void {
  bundle.discarded = true;
  bundle.watch?.unsubscribe();
  bundle.watch = null;
  for (const unbind of bundle.unbinds.splice(0)) {
    unbind();
  }
  bundle.source?.dispose();
  // After destroy: the SDK's teardown may still touch platform globals.
  const teardown = teardownClient(bundle.instance, bundle.skipRegister, () => bundle.ownPlatform?.dispose());
  if (teardown) {
    teardowns.add(teardown);
    void teardown.finally(() => teardowns.delete(teardown));
  }
}

/** Process-wide: the provider remounted after Back is a new component instance. */
const KEPT_CLIENT_KEY = '__signalwireReactKeptClient';

function keptClient(): ClientBundle | undefined {
  return (globalThis as unknown as Record<string, ClientBundle | undefined>)[KEPT_CLIENT_KEY];
}

function setKeptClient(bundle: ClientBundle | undefined): void {
  (globalThis as unknown as Record<string, ClientBundle | undefined>)[KEPT_CLIENT_KEY] = bundle;
}

/** Whether the client has a call that is not over: ringing, dialling or live. */
function hasCallsInProgress(instance: SignalWire): boolean {
  let calls: TeardownCall[] = [];
  try {
    calls = (instance.session as { calls?: TeardownCall[] } | undefined)?.calls ?? [];
  } catch {
    calls = [];
  }
  return calls.some((call) => typeof call?.status === 'string' && !ENDED_STATUSES.has(call.status));
}

/**
 * Keeps a client whose provider unmounted during a call, for the next
 * provider to take back. It is torn down once its calls have all ended with
 * nobody taking it back. One client is kept at a time: an older one is torn
 * down, its calls with it.
 */
function keepClient(bundle: ClientBundle, teardowns: Set<Promise<void>>): void {
  const older = keptClient();
  if (older && older !== bundle) {
    setKeptClient(undefined);
    retireClient(older, teardowns);
  }
  setKeptClient(bundle);
  const calls$ = (bundle.instance.session as { calls$?: Observable<TeardownCall[]> } | undefined)?.calls$;
  const check = (): void => {
    if (keptClient() === bundle && !hasCallsInProgress(bundle.instance)) {
      logger.info('The kept client has no call left; tearing it down');
      setKeptClient(undefined);
      retireClient(bundle, teardowns);
    }
  };
  bundle.watch =
    calls$
      ?.pipe(
        switchMap((calls) =>
          calls.length === 0
            ? of(calls)
            : merge(...calls.map((call) => call.status$ ?? of(call.status))).pipe(startWith(calls))
        )
      )
      .subscribe({ next: check, error: check }) ?? null;
}

/** Takes the kept client back, if there is one. */
function takeKeptClient(): ClientBundle | null {
  const bundle = keptClient();
  if (!bundle) {
    return null;
  }
  setKeptClient(undefined);
  bundle.watch?.unsubscribe();
  bundle.watch = null;
  // The new provider binds its observer again.
  for (const unbind of bundle.unbinds.splice(0)) {
    unbind();
  }
  return bundle;
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
  keepCallsOnUnmount = false,
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
  /** Clients being torn down after their live calls end; see teardownClient. */
  const teardownsRef = useRef(new Set<Promise<void>>());

  /** Set while the provider unmounts, as opposed to rebuilding its client. */
  const unmountingRef = useRef(false);
  const keepCallsRef = useRef(keepCallsOnUnmount);
  keepCallsRef.current = keepCallsOnUnmount;
  // Declared before the client effect: on unmount React runs the cleanups in
  // declaration order, so the client's cleanup sees it set. A new
  // credentialProvider or fetchToken re-runs the client effect alone.
  useEffect(() => {
    unmountingRef.current = false;
    return () => {
      unmountingRef.current = true;
    };
  }, []);

  useEffect(() => {
    const teardowns = teardownsRef.current;
    // A client kept with its calls when the last provider unmounted (Back on
    // Android, during a call) is taken back as it is, calls and token source
    // included, rather than building a second client beside it.
    const kept = keepCallsRef.current ? takeKeptClient() : null;
    const bundle = kept ?? buildClient(platform, fetchToken, credentialProvider, options);
    if (kept) {
      logger.info('Taking back the client kept for its calls in progress');
    }
    const { instance, source, clientPlatform } = bundle;
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
      subscription.unsubscribe();
      tokenSubscription?.unsubscribe();
      stopWatching?.();
      if (sourceRef.current === source) {
        sourceRef.current = null;
      }
      setClient(null);
      if (unmountingRef.current && keepCallsRef.current && hasCallsInProgress(instance)) {
        logger.info('Unmounted during a call: keeping the client and its calls');
        keepClient(bundle, teardowns);
        return;
      }
      retireClient(bundle, teardowns);
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
  // returns no unbind is bound once per client, as in 0.1.0. A client kept
  // for its calls stays bound until it is taken back or torn down: its calls
  // still reach the native call UI, and so does a call that comes in then.
  useEffect(() => {
    if (!client || boundForGood.current === client || !observer?.bindClient) {
      return undefined;
    }
    const unbind = observer.bindClient(client);
    if (typeof unbind === 'function') {
      return () => {
        const kept = keptClient();
        if (kept?.instance === client) {
          kept.unbinds.push(unbind);
        } else {
          unbind();
        }
      };
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
    const teardowns = teardownsRef.current;
    return () => {
      // A client still ending its calls is destroyed later; the platform waits for it.
      const pending = [...teardowns];
      if (pending.length === 0) {
        platform.dispose();
      } else {
        void Promise.all(pending).finally(() => platform.dispose());
      }
    };
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
