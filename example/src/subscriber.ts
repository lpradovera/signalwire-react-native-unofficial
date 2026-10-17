import { Platform } from 'react-native';

import { pickForPlatform } from './env';

/**
 * Which subscriber this device signs in as.
 *
 * Two devices registered to one subscriber both ring — that is the point, and
 * it is what a real multi-device account does. It is also inconvenient while
 * testing one platform, because every push rings the other device too. Set
 * `EXPO_PUBLIC_SW_SUBSCRIBER_REF_ANDROID` to give Android its own identity.
 *
 * This is the reference the app *asks* the support server for. The device
 * registers for push under the one the server answers with (it decides whose
 * token it mints), so the two always agree; see App.tsx.
 */
export const SUBSCRIBER_REFERENCE =
  pickForPlatform(
    Platform.OS,
    process.env.EXPO_PUBLIC_SW_SUBSCRIBER_REF,
    process.env.EXPO_PUBLIC_SW_SUBSCRIBER_REF_ANDROID
  ) ?? 'rn-example';
