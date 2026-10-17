import { PermissionsAndroid, Platform } from 'react-native';

import { logger } from '@signalwire/react';
import { getMessagingInstance, loadFirebaseMessaging } from './firebaseMessaging';

/** Android 13 (API 33) made posting notifications a runtime permission. */
const POST_NOTIFICATIONS_API = 33;

/**
 * Asks for POST_NOTIFICATIONS on Android 13 and later.
 *
 * A call push is a data message and wakes the app either way, but without the
 * grant nothing it does can be seen: no incoming-call notification, no
 * ongoing-call notification. RNFB's `requestPermission` does not ask on
 * Android (it resolves at once), so this does. A refusal is not an error.
 */
async function requestNotificationPermission(): Promise<void> {
  if (Number(Platform.Version) < POST_NOTIFICATIONS_API) {
    return;
  }
  try {
    const result = await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS');
    if (result !== 'granted') {
      logger.warn(
        `Notification permission ${String(result)}: Android will not show this app's notifications`
      );
    }
  } catch (error) {
    // No activity to ask from (a headless task); asked again next time.
    logger.debug(`Could not ask for the notification permission: ${String(error)}`);
  }
}

/**
 * Reads this device's FCM registration token.
 *
 * Returns `null` on iOS, where VoIP push is PushKit's job, and whenever
 * Firebase is absent — callers register a device the same way on both
 * platforms and simply get nothing to send.
 */
export async function getFcmToken(): Promise<string | null> {
  if (Platform.OS !== 'android') {
    return null;
  }

  const firebase = loadFirebaseMessaging();
  if (!firebase) {
    return null;
  }
  const instance = getMessagingInstance(firebase);
  if (instance === undefined) {
    return null;
  }

  await requestNotificationPermission();
  try {
    return (await firebase.getToken(instance)) || null;
  } catch (error) {
    logger.warn('Failed to read the FCM token:', error);
    return null;
  }
}

/**
 * Subscribes to FCM token changes, calling back with the current one first.
 *
 * FCM rotates tokens — on reinstall, on restore to a new device, and at its
 * own discretion. A stale token fails silently at Google, so the push simply
 * never arrives and nothing points at the cause; re-registering on refresh is
 * what keeps that from happening.
 */
export function watchFcmToken(onToken: (token: string) => void): () => void {
  if (Platform.OS !== 'android') {
    return () => undefined;
  }

  const firebase = loadFirebaseMessaging();
  if (!firebase) {
    return () => undefined;
  }
  const instance = getMessagingInstance(firebase);
  if (instance === undefined) {
    return () => undefined;
  }

  let cancelled = false;
  void getFcmToken().then((token) => {
    if (token && !cancelled) {
      onToken(token);
    }
  });

  let unsubscribe: () => void = () => undefined;
  try {
    unsubscribe = firebase.onTokenRefresh(instance, (token) => {
      if (!cancelled) {
        onToken(token);
      }
    });
  } catch (error) {
    // Called from a React effect: a throw would take the screen down.
    logger.warn(`Could not watch FCM token refreshes: ${String(error)}`);
  }

  return () => {
    cancelled = true;
    unsubscribe();
  };
}
