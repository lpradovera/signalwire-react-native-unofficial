import { getCallKit } from '@signalwire/react-native/callkit';
import { useEffect } from 'react';

import { DEVICES_URL, TOKEN_URL } from './endpoints';

/**
 * The support server's `POST /swml/decline`, on the server the app already
 * talks to (`EXPO_PUBLIC_SW_DEVICES_URL`, else `EXPO_PUBLIC_SW_TOKEN_URL`).
 */
function declineUrl(): string | undefined {
  const origin = (DEVICES_URL ?? TOKEN_URL)?.match(/^https?:\/\/[^/?#]+/)?.[0];
  return origin ? `${origin}/swml/decline` : undefined;
}

/**
 * Tells the server when the user declines a parked-caller push.
 *
 * The twin of {@link useBridgeAnswer}. In the parked-caller flow no SDK call
 * exists to reject: the caller waits on the server, and a decline in CallKit
 * or the in-app sheet reaches nobody unless the app passes it on. Without
 * this the caller hears ringback for the whole park window, then a busy
 * hangup. The push's single-use bridge token is the authority for the
 * decline, as it is for the answer.
 */
export function useBridgeDecline(): void {
  useEffect(() => {
    const url = declineUrl();
    if (!url) {
      return;
    }

    const subscription = getCallKit().registry.rejectRequested$.subscribe((entry) => {
      const bridgeToken = entry.data?.bridgeToken;
      if (!bridgeToken) {
        // Not a parked-caller push: its SDK call, if one comes, is rejected
        // when it arrives.
        return;
      }
      void (async () => {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bridgeToken })
          });
          // 409: already answered or declined (another device, or a repeat);
          // 410: the park ran out. Either way the caller is no longer waiting
          // on this decline.
          if (!response.ok && response.status !== 409 && response.status !== 410) {
            console.warn(`Bridge decline failed: ${response.status}`);
          }
        } catch (error) {
          console.warn('Bridge decline failed:', (error as Error).message);
        }
      })();
    });

    return () => subscription.unsubscribe();
  }, []);
}
