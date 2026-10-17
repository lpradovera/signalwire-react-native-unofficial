import { SIRI_INTENT_SOURCE } from './siriIntentSource';
import { withObjcSource } from './withObjcSource';

import type { ConfigPlugin } from 'expo/config-plugins';

/**
 * Injects `SignalWireSiriCallIntent.m`, which gives the AppDelegate an
 * `application:handlerForIntent:` for Siri's `INStartCallIntent`. Applied with
 * `enableSiri`. See `siriIntentSource.ts`.
 */
export const withSiriCallIntent: ConfigPlugin = withObjcSource(
  'SignalWireSiriCallIntent.m',
  SIRI_INTENT_SOURCE,
  'the Siri call intent handler'
);
