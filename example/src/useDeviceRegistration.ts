import { watchPushToken } from '@signalwire/react-native/callkit';
import * as Application from 'expo-application';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { apnsEnvironmentFor, registerDevice, registerWithRetry } from './deviceRegistration';
import { DEVICES_URL } from './endpoints';

import type { ApnsEnvironment } from './deviceRegistration';

/**
 * The APNs environment of this build's PushKit token, from the provisioning
 * profile's `aps-environment`. A hard-coded 'sandbox' was wrong for every
 * TestFlight and App Store build, and `__DEV__` is wrong for a Release build
 * signed with a development profile. Not consulted on Android.
 */
async function apnsEnvironment(): Promise<ApnsEnvironment> {
  if (Platform.OS !== 'ios') {
    return 'production';
  }
  return apnsEnvironmentFor(await Application.getIosPushNotificationServiceEnvironmentAsync());
}

/**
 * Registers this device's push token with the support server.
 *
 * Set `EXPO_PUBLIC_SW_DEVICES_URL` to the server's `/devices` endpoint.
 * `externalUserId` must be the subscriber reference the signed-in token was
 * minted for, or pushes are sent to the wrong device — the server looks
 * devices up by exactly that key. `null` means it is not known (a pasted token
 * with no reference given), and the device is not registered at all.
 *
 * Registration is re-run whenever the platform reissues the token, and a
 * failed one is retried: a token is handed over once per launch, and a stale
 * or missing registration fails silently — at APNs, and at FCM — so the push
 * simply never arrives and nothing points at the cause.
 */
export function useDeviceRegistration(externalUserId: string | null): void {
  useEffect(() => {
    const url = DEVICES_URL;
    if (!url) {
      return;
    }
    if (!externalUserId) {
      console.warn(
        'Push registration skipped: no subscriber reference for this token. ' +
          'Enter the reference the token was minted for to receive calls.'
      );
      return;
    }

    let stopRetrying: (() => void) | null = null;
    const stopWatching = watchPushToken((registration) => {
      // A reissued token replaces the old one; stop retrying the old one.
      stopRetrying?.();
      stopRetrying = registerWithRetry(
        async () =>
          registerDevice({
            url,
            externalUserId,
            registration,
            environment: await apnsEnvironment()
          }),
        {
          onError: (error, willRetry) =>
            console.warn(
              `${(error as Error).message}${willRetry ? '; retrying' : '; not retrying'}`
            )
        }
      );
    });

    return () => {
      stopWatching();
      stopRetrying?.();
    };
  }, [externalUserId]);
}
