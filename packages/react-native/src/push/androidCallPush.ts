import { Platform } from 'react-native';

import { logger } from '@signalwire/react';
import { getCallKit } from '../callkit/CallKeepBridge';
import { getMessagingInstance, loadFirebaseMessaging } from './firebaseMessaging';

import type { RemoteMessage } from './firebaseMessaging';

/**
 * Undoes the renaming the sender had to do to satisfy FCM.
 *
 * FCM rejects a data payload containing `from` — and `to`, `notification`,
 * `message_type`, `collapse_key`, or anything prefixed `google`/`gcm` — with
 * `400 Invalid data payload key`, failing the whole message. The server
 * prefixes those with `sw_`; this puts them back, so nothing downstream has to
 * care which push service delivered the call.
 */
export function decodePushData(data: Record<string, string>): Record<string, string> {
  const decoded: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    const original = key.startsWith('sw_') ? key.slice(3) : null;
    // Only what the sender renamed: an app's own `sw_` key arrives as it was sent.
    decoded[original !== null && isFcmReserved(original) ? original : key] = value;
  }
  return decoded;
}

/** The keys the server's FcmSender renames; kept in step with it. */
const FCM_RESERVED_KEYS = new Set(['from', 'to', 'notification', 'message_type', 'collapse_key']);

function isFcmReserved(key: string): boolean {
  return FCM_RESERVED_KEYS.has(key) || key.startsWith('google') || key.startsWith('gcm');
}

/** Turns an FCM data message into a native incoming call. */
function reportCall(message: RemoteMessage): void {
  const data = decodePushData(message.data ?? {});
  const callId = data.call_id;
  if (!callId) {
    logger.debug('FCM message carries no call_id; not a call, ignoring');
    return;
  }

  logger.debug(`FCM call push received for ${callId}`);
  const extras = { ...data };
  delete extras.call_id;
  delete extras.from;
  delete extras.from_name;
  const bridge = getCallKit();
  bridge.reportIncomingPush({
    callId,
    from: data.from,
    fromName: data.from_name,
    // Everything else rides along — a bridge topology puts its single-use
    // token here, and there is no second chance to ask for it. Only the
    // extras, as on iOS, where the PushKit handler strips the same fields.
    data: extras
  });

  // The push may have woken a killed app into a headless task, where nothing
  // is on screen. Without this the call sits in Telecom, invisible.
  bridge.bringToForeground();
}

/**
 * Wires FCM call pushes into the native call UI.
 *
 * Call this from the app's entry file, outside React. Two handlers, because
 * Android delivers to different places depending on whether the app is alive:
 *
 * - `setBackgroundMessageHandler` runs in a headless JavaScript task when the
 *   app is backgrounded or killed. This is the cold-start path, and the one
 *   that matters: an incoming call normally arrives at a dead app.
 * - `onMessage` runs when the app is in the foreground, where the background
 *   handler is never called.
 *
 * Registering only one of them produces a bug that looks like flakiness —
 * calls arrive when the app happens to be open and vanish when it is not.
 *
 * Safe to call on iOS and without Firebase installed: both are no-ops.
 */
export function registerAndroidCallPush(): void {
  if (Platform.OS !== 'android') {
    return;
  }

  const firebase = loadFirebaseMessaging();
  if (!firebase) {
    return;
  }
  const instance = getMessagingInstance(firebase);
  if (instance === undefined) {
    return;
  }

  try {
    firebase.setBackgroundMessageHandler(instance, async (message) => {
      reportCall(message);
    });
    firebase.onMessage(instance, (message) => {
      reportCall(message);
    });
  } catch (error) {
    // Runs in the entry file: a throw here would stop registerRootComponent.
    logger.warn(`Could not register the FCM handlers; Android call push is off: ${String(error)}`);
    return;
  }

  logger.debug('Android call push registered');
}
