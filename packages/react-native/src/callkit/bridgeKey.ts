/**
 * Where the process-wide CallKit bridge lives on `globalThis`; see
 * `getCallKit`.
 *
 * Its own module, with no imports, because two files need it and one of them
 * must not import the other: `useRingingPushes` (the `./ringing` entry) reads
 * the bridge without importing `CallKeepBridge`, which would pull in
 * `react-native-callkeep` and make an optional peer mandatory. Spelled in both
 * files, a rename on one side left the hook reading an empty slot.
 */
export const CALLKIT_BRIDGE_KEY = '__signalwireRNCallKitBridge';
