import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * The callkeep packages the app may have, the SignalWire fork first; the same
 * order the runtime uses (`callkit/callkeepModule`). Spelled here too because
 * the plugin is built for Node, apart from the runtime bundles.
 */
const CALLKEEP_PACKAGES = ['@signalwire/react-native-callkeep', 'react-native-callkeep'] as const;

/**
 * Which callkeep the app at `projectRoot` can resolve: the SignalWire fork
 * `@signalwire/react-native-callkeep` first, else stock
 * `react-native-callkeep`, else undefined. Both build the same `RNCallKeep`
 * pod and `io.wazo.callkeep` Android package.
 *
 * `resolve` is Node's, from the project root; tests pass their own.
 */
export function findCallKeep(
  projectRoot: string,
  resolve: (request: string) => string = createRequire(path.join(projectRoot, 'package.json')).resolve
): (typeof CALLKEEP_PACKAGES)[number] | undefined {
  for (const name of CALLKEEP_PACKAGES) {
    try {
      resolve(`${name}/package.json`);
      return name;
    } catch {
      // Not installed under this name; try the next.
    }
  }
  return undefined;
}

/**
 * Whether the app at `projectRoot` has either callkeep.
 *
 * The generated PushKit hook imports `RNCallKeep.h` and reports every push
 * through callkeep, so without it the iOS build fails ("'RNCallKeep.h' file
 * not found"). callkeep is an optional peer, so its absence is a supported
 * setup, not an error, unless VoIP push was asked for explicitly.
 */
export function isCallKeepInstalled(projectRoot: string): boolean {
  return findCallKeep(projectRoot) !== undefined;
}
