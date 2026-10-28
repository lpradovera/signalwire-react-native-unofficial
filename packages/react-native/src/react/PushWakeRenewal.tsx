import { logger, SignalWireContext } from '@signalwire/react';
import { useContext, useEffect, useRef } from 'react';

import { getCallKit } from '../callkit/CallKeepBridge';

/**
 * Renews a `fetchToken` token when a call push arrives.
 *
 * A push can wake a suspended app whose token ran out while its timers were
 * stopped, and answering it from the lock screen leaves the app in the
 * background, so the foreground check never runs. The SDK reconnects through
 * the same token source; this starts the renewal (or a waiting retry) the
 * moment the push lands instead of when the reconnect asks for it. A push
 * that rings while the server refuses the token is logged as an error, not
 * left to time out unexplained.
 *
 * Rendered by the React Native `SignalWireProvider` with `fetchToken` and
 * `callKit` both set. Renders nothing.
 */
export function PushWakeRenewal(): null {
  const context = useContext(SignalWireContext);
  const latest = useRef(context);
  latest.current = context;

  useEffect(() => {
    const seen = new Set<string>();
    const subscription = getCallKit().registry.entries$.subscribe((entries) => {
      for (const entry of entries) {
        if (entry.state !== 'pending-push' || seen.has(entry.uuid)) {
          continue;
        }
        seen.add(entry.uuid);
        const status = latest.current?.tokenStatus;
        if (status?.state === 'unauthorized') {
          logger.error(
            `Call push ${entry.uuid} arrived, but the client cannot connect: fetchToken is unauthorized.`,
            status.error
          );
        }
        latest.current?.renewTokenIfDue?.();
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  return null;
}
