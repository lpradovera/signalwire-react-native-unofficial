import { useCallback, useContext, useMemo } from 'react';
import { of, switchMap } from 'rxjs';

import { holdOtherCalls, liveCallsOf } from './liveCalls';
import { logger } from './logger';
import { SignalWireContext } from './SignalWireProvider';
import { useObservable } from './useObservable';

import type { OtherCalls } from './types';
import type { Call, MediaOptions } from '@signalwire/js';
import type { Observable } from 'rxjs';

const NO_CALLS: Call[] = [];

export interface UseIncomingCallsResult {
  readonly calls: Call[];
  /**
   * Answers `call`. A call already in progress is put on hold first (Hold &
   * Accept), so the answered call is the only one with live media.
   */
  answer(call: Call, options?: MediaOptions): Promise<void>;
  /** Ends every call in progress, then answers `call` (End & Accept). */
  endAndAnswer(call: Call, options?: MediaOptions): Promise<void>;
  reject(call: Call): Promise<void>;
}

/**
 * Pending inbound calls from the SDK session.
 *
 * With CallKit enabled the native UI usually handles these first; this hook
 * remains useful for in-app inbound UI and for apps that do not use CallKit.
 */
export function useIncomingCalls(): UseIncomingCallsResult {
  const context = useContext(SignalWireContext);
  const client = context?.client;
  const observer = context?.observer;
  // The session exists only from the end of connect() until disconnect(), and
  // a later connect() builds a new one. Reading client.session during render
  // missed both: nothing re-renders this component when the session appears,
  // so it never subscribed. isConnected$ changes at exactly those points.
  const incomingCalls$ = useMemo<Observable<Call[]> | undefined>(
    () =>
      client?.isConnected$.pipe(
        switchMap(() => client.session?.incomingCalls$ ?? of(NO_CALLS))
      ),
    [client]
  );
  const calls = useObservable(incomingCalls$, client?.session?.incomingCalls ?? NO_CALLS);

  const answerWith = useCallback(
    async (call: Call, options: MediaOptions | undefined, others: OtherCalls): Promise<void> => {
      // The observer answers through the native call UI when it can, so the OS
      // activates the audio session and dismisses its ringing screen. Answering
      // the SDK directly while CallKit still rings yields a connected call
      // with no audio. When the observer takes over, it also holds or ends
      // the other calls (as the native Hold & Accept and End & Accept do),
      // the native answer flow calls `call.answer` itself, and `options` are
      // not applied.
      if (observer?.onIncomingAnswer?.(call, others)) {
        return;
      }
      if (others === 'hold') {
        await holdOtherCalls(client, observer, call);
      } else {
        for (const live of liveCallsOf(client).filter((other) => other !== call)) {
          await live.hangup().catch((error: unknown) => logger.debug('Hangup before answering failed:', error));
        }
      }
      await call.answer(options);
    },
    [client, observer]
  );

  const answer = useCallback(
    (call: Call, options?: MediaOptions): Promise<void> => answerWith(call, options, 'hold'),
    [answerWith]
  );

  const endAndAnswer = useCallback(
    (call: Call, options?: MediaOptions): Promise<void> => answerWith(call, options, 'end'),
    [answerWith]
  );

  const reject = useCallback(
    async (call: Call): Promise<void> => {
      if (observer?.onIncomingReject?.(call)) {
        return;
      }
      try {
        await call.reject();
      } catch (error) {
        logger.debug('Reject on an already-ended call:', error);
      }
    },
    [observer]
  );

  return { calls, answer, endAndAnswer, reject };
}
