import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Whether the app at `projectRoot` can resolve `react-native-callkeep`.
 *
 * The generated PushKit hook imports `RNCallKeep.h` and reports every push
 * through callkeep, so without it the iOS build fails ("'RNCallKeep.h' file
 * not found"). callkeep is an optional peer, so its absence is a supported
 * setup, not an error, unless VoIP push was asked for explicitly.
 */
export function isCallKeepInstalled(projectRoot: string): boolean {
  try {
    createRequire(path.join(projectRoot, 'package.json')).resolve('react-native-callkeep/package.json');
    return true;
  } catch {
    return false;
  }
}
