/**
 * Tells the support server when the user declines a parked-caller push.
 *
 * In the parked-caller flow no SDK call exists to reject: the caller waits on
 * the server, and a decline in CallKit, the call notification or the in-app
 * sheet reaches nobody unless the app passes it on. Without it the caller
 * hears ringback for the whole park window, then a busy hangup. The push's
 * single-use bridge token is the authority for the decline, as it is for the
 * answer.
 *
 * Registered from index.js, outside React, like registerAndroidCallPush: on
 * Android a push to a killed app runs in a headless JavaScript context where
 * React never mounts, and Decline on the call notification does not open the
 * app. A decline wired in a component was never sent in exactly that case.
 */

/** The registry's decline stream, as `getCallKit().registry` provides it. */
export interface DeclineSource {
  rejectRequested$: {
    subscribe(listener: (entry: { data?: Record<string, string> }) => void): { unsubscribe(): void };
  };
}

/**
 * The support server's `POST /swml/decline`, on the server the app already
 * talks to (`EXPO_PUBLIC_SW_DEVICES_URL`, else `EXPO_PUBLIC_SW_TOKEN_URL`).
 */
export function declineUrl(devicesUrl: string | undefined, tokenUrl: string | undefined): string | undefined {
  const origin = (devicesUrl ?? tokenUrl)?.match(/^https?:\/\/[^/?#]+/)?.[0];
  return origin ? `${origin}/swml/decline` : undefined;
}

let active: { unsubscribe(): void } | null = null;

/**
 * Posts each declined bridge push to `url`. Registers once per JavaScript
 * context; returns a function that removes the registration.
 */
export function registerBridgeDecline({
  registry,
  url,
  fetchImpl = fetch
}: {
  registry: DeclineSource;
  url: string | undefined;
  fetchImpl?: typeof fetch;
}): () => void {
  const stop = (): void => {
    active?.unsubscribe();
    active = null;
  };
  if (!url || active) {
    return stop;
  }

  active = registry.rejectRequested$.subscribe((entry) => {
    const bridgeToken = entry.data?.bridgeToken;
    if (!bridgeToken) {
      // Not a parked-caller push: its SDK call, if one comes, is rejected
      // when it arrives.
      return;
    }
    void (async () => {
      try {
        const response = await fetchImpl(url, {
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
  return stop;
}
