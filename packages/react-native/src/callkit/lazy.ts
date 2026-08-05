import type { CallKeepBridge } from './CallKeepBridge';

/**
 * Loads the CallKit bridge at call time rather than import time.
 *
 * The type import above is erased at build time, so Metro only resolves
 * `react-native-callkeep` for apps that actually enable the native call UI.
 */
export function loadCallKit(): CallKeepBridge {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const module = require('./CallKeepBridge') as { getCallKit(): CallKeepBridge };
  return module.getCallKit();
}
