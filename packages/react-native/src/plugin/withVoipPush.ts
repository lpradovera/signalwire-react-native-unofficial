import { VOIP_PUSH_SOURCE } from './voipPushSource';
import { withObjcSource } from './withObjcSource';

import type { ConfigPlugin } from '@expo/config-plugins';

/**
 * Injects the native VoIP push hook (`SignalWireVoipPush.m`).
 *
 * Only applied when `enableVoipPush` is on: an app without a VoIP entitlement
 * that registers a `PKPushRegistry` is asking iOS for a capability it does not
 * have.
 */
export const withVoipPush: ConfigPlugin = withObjcSource(
  'SignalWireVoipPush.m',
  VOIP_PUSH_SOURCE,
  'the VoIP push hook'
);
