/**
 * Native call UI: CallKit on iOS, ConnectionService on Android.
 *
 * Requires the optional peer `react-native-callkeep`.
 *
 * ```ts
 * // index.js — before React mounts, so a cold-start VoIP push finds it ready
 * import { getCallKit } from '@signalwire/react-native/callkit';
 * void getCallKit().setup({ appName: 'Demo' });
 *
 * // your VoIP push handler
 * getCallKit().reportIncomingPush({ callId, from, fromName });
 * ```
 */
export { CallKeepBridge, getCallKit, resetCallKitForTesting } from './callkit/CallKeepBridge';
export type { CallKitSetupOptions } from './callkit/CallKeepBridge';
export { CallRegistry } from './callkit/CallRegistry';
export type {
  CallEntry,
  CallEntryState,
  CallIntent,
  CallRegistryHost,
  CallRegistryOptions,
  PushPayload
} from './callkit/types';
