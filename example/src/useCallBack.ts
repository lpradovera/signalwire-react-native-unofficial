import { useSignalWire } from '@signalwire/react-native';
import { getCallKit } from '@signalwire/react-native/callkit';
import { useEffect, useRef } from 'react';

import type { Call } from '@signalwire/js';

/** How long a call-back that launched the app may wait for the connection. */
const CALL_BACK_CONNECT_TIMEOUT_MS = 15000;

async function waitFor(ready: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!ready() && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/**
 * Dials a call-back the user started from the Phone app's Recents or from
 * Siri ("call back"). The tap often launches the app, so the request can
 * arrive before the client is connected: wait for it, as the bridge answer
 * does. Subscribed once, with `dial` and `onCallStarted` read through refs, so
 * a held call-back is not delivered to a subscription that is then dropped.
 */
export function useCallBack(onCallStarted: (call: Call) => void): void {
  const { dial, isConnected } = useSignalWire();
  const latest = useRef({ dial, isConnected, onCallStarted });
  latest.current = { dial, isConnected, onCallStarted };

  useEffect(() => {
    const subscription = getCallKit().startCallRequested$.subscribe((request) => {
      void (async () => {
        if (!latest.current.isConnected) {
          await waitFor(() => latest.current.isConnected, CALL_BACK_CONNECT_TIMEOUT_MS);
        }
        if (!latest.current.isConnected) {
          console.warn(`SDK never connected; cannot call back ${request.handle}`);
          return;
        }
        try {
          const call = await latest.current.dial(request.handle, {
            audio: true,
            video: request.video
          });
          latest.current.onCallStarted(call);
        } catch (error) {
          console.warn(`Call-back to ${request.handle} failed:`, error);
        }
      })();
    });
    return () => subscription.unsubscribe();
  }, []);
}
