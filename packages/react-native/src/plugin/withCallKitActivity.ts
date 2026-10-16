import { CALLKIT_ACTIVITY_SOURCE } from './callKitActivitySource';
import { withObjcSource } from './withObjcSource';

import type { ConfigPlugin } from '@expo/config-plugins';

/**
 * Injects the Recents / Siri call-back forwarder
 * (`SignalWireCallKitActivity.m`), which hands `INStartCallIntent` activities
 * to RNCallKeep. Applied with `enableCallKit`. See `callKitActivitySource.ts`.
 */
export const withCallKitActivity: ConfigPlugin = withObjcSource(
  'SignalWireCallKitActivity.m',
  CALLKIT_ACTIVITY_SOURCE,
  'the Recents call-back forwarder'
);
