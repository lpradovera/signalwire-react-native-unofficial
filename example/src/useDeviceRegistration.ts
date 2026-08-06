import { watchVoipToken } from '@signalwire/react-native/callkit';
import { useEffect } from 'react';

/**
 * Registers this device's VoIP push token with the support server.
 *
 * Set `EXPO_PUBLIC_SW_DEVICES_URL` to the server's `/devices` endpoint. The
 * `externalUserId` must match the subscriber reference the token is minted
 * for, or pushes are sent to the wrong device — the server looks devices up by
 * exactly that key.
 *
 * Registration is re-run whenever iOS reissues the token: a stale token fails
 * silently at APNs, so the push simply never arrives and nothing points at the
 * cause.
 */
export function useDeviceRegistration(externalUserId: string): void {
  useEffect(() => {
    const url = process.env.EXPO_PUBLIC_SW_DEVICES_URL;
    if (!url) {
      return;
    }

    return watchVoipToken((token) => {
      void (async () => {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              externalUserId,
              platform: 'ios',
              token,
              // A development build is signed for the APNs sandbox. Sending a
              // sandbox token to production (or the reverse) fails at Apple
              // with a device-token mismatch, which is easy to misread as a
              // bad token.
              environment: 'sandbox'
            })
          });
          if (!response.ok) {
            console.warn(`Device registration failed: ${response.status}`);
          }
        } catch (error) {
          console.warn('Device registration failed:', (error as Error).message);
        }
      })();
    });
  }, [externalUserId]);
}
