import { Platform } from 'react-native';

/**
 * Which subscriber this device signs in as.
 *
 * Two devices registered to one subscriber both ring — that is the point, and
 * it is what a real multi-device account does. It is also inconvenient while
 * testing one platform, because every push rings the other device too. Set
 * `EXPO_PUBLIC_SW_SUBSCRIBER_REF_ANDROID` to give Android its own identity.
 *
 * Used for both the token request and the device registration: they must
 * agree, or the device registers under one subscriber and receives tokens for
 * another, and pushes go somewhere the app is not listening.
 */
export const SUBSCRIBER_REFERENCE =
  (Platform.OS === 'android' ? process.env.EXPO_PUBLIC_SW_SUBSCRIBER_REF_ANDROID : undefined) ??
  process.env.EXPO_PUBLIC_SW_SUBSCRIBER_REF ??
  'rn-example';
