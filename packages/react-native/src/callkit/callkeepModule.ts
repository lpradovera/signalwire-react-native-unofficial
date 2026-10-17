import { MissingPeerDependencyError } from '../errors';

import type RNCallKeep from '@signalwire/react-native-callkeep';
import type { CONSTANTS } from '@signalwire/react-native-callkeep';

// Metro supplies `require` at runtime; this package's tsconfig has no Node types.
declare const require: (moduleName: string) => unknown;

/**
 * The callkeep packages this package can drive, in order of preference.
 *
 * `@signalwire/react-native-callkeep` is the SignalWire-maintained fork, with
 * the fixes the bridge relies on (stock 4.3.16 is refused by the New
 * Architecture at launch on Android, and has no `didFailCallAction`). Stock
 * `react-native-callkeep` has the same JS API and still works for an app that
 * has it. The types are the fork's: its API is a superset of stock's.
 */
export const CALLKEEP_PACKAGES = ['@signalwire/react-native-callkeep', 'react-native-callkeep'] as const;

export type CallKeepPackage = (typeof CALLKEEP_PACKAGES)[number];

/** callkeep's default export: the module object the bridge calls. */
export type CallKeep = typeof RNCallKeep;

/** The callkeep this app has: its default export, CONSTANTS, and its name. */
export interface ResolvedCallKeep {
  packageName: CallKeepPackage;
  module: CallKeep;
  constants: typeof CONSTANTS;
}

interface Namespace {
  default?: unknown;
  CONSTANTS?: unknown;
}

/** The first line of an error: a native throw carries the whole stack. */
function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const end = text.indexOf('\n');
  return end === -1 ? text : text.slice(0, end);
}

/** What Metro's and Jest's require throw for a package that is not installed. */
function isNotInstalled(error: unknown): boolean {
  return firstLine(error).startsWith('Cannot find module');
}

function fromNamespace(packageName: CallKeepPackage, loaded: unknown): ResolvedCallKeep | undefined {
  const namespace = loaded as Namespace | undefined;
  const module = (namespace?.default ?? namespace) as CallKeep | undefined;
  const constants = (namespace?.CONSTANTS ?? (module as unknown as Namespace | undefined)?.CONSTANTS) as
    | typeof CONSTANTS
    | undefined;
  if (module === undefined || module === null || constants === undefined) {
    return undefined;
  }
  return { packageName, module, constants };
}

/** Why no callkeep could be used, for the error `requireCallKeep` throws. */
const failures: string[] = [];

/**
 * Finds callkeep, the fork first. Never throws. Called once, while this
 * module is evaluated (see `resolved`).
 *
 * Each `require` is a literal, so Metro collects both, and each sits in a try,
 * so Metro bundles them as optional dependencies: the one the app did not
 * install is left out of the bundle and its `require` throws "Cannot find
 * module" here. An installed callkeep can also throw while it is evaluated
 * (on iOS, an unlinked one fails `new NativeEventEmitter(null)`'s invariant);
 * that is recorded, and the error says so.
 */
function resolveCallKeep(): ResolvedCallKeep | undefined {
  try {
    const found = fromNamespace('@signalwire/react-native-callkeep', require('@signalwire/react-native-callkeep'));
    if (found) {
      return found;
    }
  } catch (error) {
    if (!isNotInstalled(error)) {
      failures.push(`@signalwire/react-native-callkeep failed to load: ${firstLine(error)}`);
    }
  }
  try {
    const found = fromNamespace('react-native-callkeep', require('react-native-callkeep'));
    if (found) {
      return found;
    }
  } catch (error) {
    if (!isNotInstalled(error)) {
      failures.push(`react-native-callkeep failed to load: ${firstLine(error)}`);
    }
  }
  return undefined;
}

/**
 * Resolved while this module is evaluated, not on first use.
 *
 * Metro reports a throw from a module loaded *outside* another module's load
 * as a fatal error before the caller's `catch` runs (see
 * `push/firebaseMessaging.ts`). During this module's own evaluation Metro is
 * inside a load guard, so a missing or failing callkeep reaches the catches
 * above and the bridge simply has none.
 */
const resolved: ResolvedCallKeep | undefined = resolveCallKeep();

/** The callkeep this app has, or undefined when it has neither. Never throws. */
export function getCallKeep(): ResolvedCallKeep | undefined {
  return resolved;
}

/**
 * The callkeep this app has, or a {@link MissingPeerDependencyError} that names
 * the fork to install (and stock callkeep as the alternative), with the reason
 * an installed one failed to load.
 */
export function requireCallKeep(feature: string): ResolvedCallKeep {
  if (resolved) {
    return resolved;
  }
  throw new MissingPeerDependencyError(CALLKEEP_PACKAGES[0], feature, {
    alternative: CALLKEEP_PACKAGES[1],
    detail: failures.join('\n') || undefined
  });
}
