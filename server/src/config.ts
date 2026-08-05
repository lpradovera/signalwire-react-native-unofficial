import { ApnsVoipSender } from './core/ApnsVoipSender.js';
import { FcmSender } from './core/FcmSender.js';

import type { PushSender } from './core/types.js';

/** Reads a PEM from the environment, tolerating `\n`-escaped one-liners. */
function pem(value: string): string {
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
}

/**
 * Builds whichever senders are configured.
 *
 * Both are optional so you can bring up one platform at a time — which is the
 * sane way to debug push. Anything missing is reported, not silently skipped.
 */
export function createSendersFromEnv(env: NodeJS.ProcessEnv = process.env): {
  senders: PushSender[];
  missing: string[];
} {
  const senders: PushSender[] = [];
  const missing: string[] = [];

  const { APNS_TEAM_ID, APNS_KEY_ID, APNS_P8_KEY, IOS_BUNDLE_ID } = env;
  if (APNS_TEAM_ID && APNS_KEY_ID && APNS_P8_KEY && IOS_BUNDLE_ID) {
    senders.push(
      new ApnsVoipSender({
        teamId: APNS_TEAM_ID,
        keyId: APNS_KEY_ID,
        privateKey: pem(APNS_P8_KEY),
        bundleId: IOS_BUNDLE_ID
      })
    );
  } else {
    missing.push('iOS (needs APNS_TEAM_ID, APNS_KEY_ID, APNS_P8_KEY, IOS_BUNDLE_ID)');
  }

  const { FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY } = env;
  if (FCM_PROJECT_ID && FCM_CLIENT_EMAIL && FCM_PRIVATE_KEY) {
    senders.push(
      new FcmSender({
        projectId: FCM_PROJECT_ID,
        clientEmail: FCM_CLIENT_EMAIL,
        privateKey: pem(FCM_PRIVATE_KEY)
      })
    );
  } else {
    missing.push('Android (needs FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY)');
  }

  return { senders, missing };
}
