import { useCallback, useContext } from 'react';

import { logger } from './logger';
import { SignalWireContext } from './SignalWireProvider';
import { useObservable } from './useObservable';

import type { Call, MediaOptions } from '@signalwire/js';

const NO_CALLS: Call[] = [];

export interface UseIncomingCallsResult {
  readonly calls: Call[];
  answer(call: Call, options?: MediaOptions): Promise<void>;
  reject(call: Call): Promise<void>;
}

/**
 * Pending inbound calls from the SDK session.
 *
 * With CallKit enabled the native UI usually handles these first; this hook
 * remains useful for in-app inbound UI and for apps that do not use CallKit.
 */
export function useIncomingCalls(): UseIncomingCallsResult {
  const session = useContext(SignalWireContext)?.client?.session;
  const calls = useObservable(session?.incomingCalls$, session?.incomingCalls ?? NO_CALLS);

  const answer = useCallback(async (call: Call, options?: MediaOptions): Promise<void> => {
    await call.answer(options);
  }, []);

  const reject = useCallback(async (call: Call): Promise<void> => {
    try {
      await call.reject();
    } catch (error) {
      logger.debug('Reject on an already-ended call:', error);
    }
  }, []);

  return { calls, answer, reject };
}
