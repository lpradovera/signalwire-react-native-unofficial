import { useCallback, useContext, useMemo } from 'react';
import { EMPTY, catchError, combineLatest, map, merge, of, startWith, switchMap } from 'rxjs';

import { getCallHoldState } from './callHold';
import { holdOtherCalls, isLiveCall, setCallHeld } from './liveCalls';
import { SignalWireContext } from './SignalWireProvider';
import { useObservable } from './useObservable';

import type { Call } from '@signalwire/js';
import type { Observable } from 'rxjs';

export interface UseCallsResult {
  /** Every call in progress (placed, or answered), oldest first. */
  readonly calls: Call[];
  /**
   * The call in progress that is not on hold: the one with live media. With
   * more than one not on hold, the newest. Null when there is none.
   */
  readonly activeCall: Call | null;
  /** The calls in progress that are on hold, oldest first. */
  readonly heldCalls: Call[];
  /** Whether `call` is on hold. */
  isHeld(call: Call): boolean;
  /** Puts `call` on hold. */
  hold(call: Call): Promise<void>;
  /**
   * Takes `call` off hold, putting the active call on hold first, so one call
   * at a time has live media.
   */
  unhold(call: Call): Promise<void>;
  /**
   * Holds the active call and resumes the held one (the oldest, with more
   * than one). Does nothing without a held call.
   */
  swap(): Promise<void>;
}

interface CallsState {
  readonly calls: Call[];
  readonly activeCall: Call | null;
  readonly heldCalls: Call[];
}

const NO_CALLS: CallsState = { calls: [], activeCall: null, heldCalls: [] };

function stateOf(calls: Call[], held: ReadonlySet<Call>): CallsState {
  const live = calls.filter(isLiveCall);
  if (live.length === 0) {
    return NO_CALLS;
  }
  const state = getCallHoldState();
  const heldCalls = live.filter((call) => held.has(call) || state.isHeld(call));
  const unheld = live.filter((call) => !heldCalls.includes(call));
  return { calls: live, activeCall: unheld[unheld.length - 1] ?? null, heldCalls };
}

/** Re-emits `calls` whenever any of their statuses changes. */
function withStatusChanges(calls: Call[]): Observable<Call[]> {
  if (calls.length === 0) {
    return of(calls);
  }
  const changes = calls.map((call) => {
    try {
      return call.status$.pipe(catchError(() => EMPTY));
    } catch {
      // A destroyed call's status$ getter throws.
      return EMPTY;
    }
  });
  return merge(...changes).pipe(
    map(() => calls),
    startWith(calls)
  );
}

/**
 * The calls in progress, which one is active and which are on hold (call
 * waiting), with the hold, resume and swap actions.
 *
 * Holds go through the native call UI's observer on React Native, so CallKit
 * and Telecom show the same state, and a hold made in the native UI shows
 * here.
 */
export function useCalls(): UseCallsResult {
  const context = useContext(SignalWireContext);
  const client = context?.client;
  const observer = context?.observer;

  // Rebuilt for a new client only. The session exists from the end of
  // connect() until disconnect(), and a reconnect builds a new one, so it is
  // read again each time the connection changes.
  const state$ = useMemo<Observable<CallsState> | undefined>(() => {
    if (!client) {
      return undefined;
    }
    const calls$ = client.isConnected$.pipe(
      switchMap(() => client.session?.calls$ ?? of<Call[]>([])),
      switchMap(withStatusChanges)
    );
    return combineLatest([calls$, getCallHoldState().held$]).pipe(
      map(([calls, held]) => stateOf(calls, held))
    );
  }, [client]);

  const initial = useMemo(() => {
    let calls: Call[] = [];
    try {
      calls = client?.session?.calls ?? [];
    } catch {
      calls = [];
    }
    return stateOf(calls, getCallHoldState().held);
  }, [client]);

  const { calls, activeCall, heldCalls } = useObservable(state$, initial);

  const isHeld = useCallback((call: Call) => getCallHoldState().isHeld(call), []);

  const hold = useCallback((call: Call) => setCallHeld(call, true, observer), [observer]);

  const unhold = useCallback(
    async (call: Call): Promise<void> => {
      await holdOtherCalls(client, observer, call);
      await setCallHeld(call, false, observer);
    },
    [client, observer]
  );

  const swap = useCallback(async (): Promise<void> => {
    const next = heldCalls[0];
    if (next) {
      await unhold(next);
    }
  }, [heldCalls, unhold]);

  return { calls, activeCall, heldCalls, isHeld, hold, unhold, swap };
}
