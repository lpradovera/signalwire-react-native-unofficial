import { NativeModules, Platform } from 'react-native';

import { logger } from '@signalwire/react';

// Metro supplies `require` at runtime; this package's tsconfig has no Node types.
declare const require: (moduleName: string) => unknown;

/** An FCM message, as RNFB hands it to a handler. */
export interface RemoteMessage {
  data?: Record<string, string>;
}

/**
 * The slice of `@react-native-firebase/messaging`'s modular API this package
 * uses. Declared structurally so the package type-checks without Firebase,
 * which is an optional peer.
 */
export interface FirebaseMessaging {
  getMessaging(): unknown;
  getToken(messaging: unknown): Promise<string>;
  onTokenRefresh(messaging: unknown, listener: (token: string) => void): () => void;
  onMessage(messaging: unknown, handler: (message: RemoteMessage) => void): () => void;
  setBackgroundMessageHandler(
    messaging: unknown,
    handler: (message: RemoteMessage) => Promise<void>
  ): void;
}

const REQUIRED: ReadonlyArray<keyof FirebaseMessaging> = [
  'getMessaging',
  'getToken',
  'onTokenRefresh',
  'onMessage',
  'setBackgroundMessageHandler'
];

/** The native modules RNFB looks up while its JavaScript is evaluated. */
const NATIVE_MODULES = ['RNFBAppModule', 'RNFBMessagingModule'];

function hasModularApi(candidate: unknown): candidate is FirebaseMessaging {
  if (candidate === null || (typeof candidate !== 'object' && typeof candidate !== 'function')) {
    return false;
  }
  const members = candidate as Record<string, unknown>;
  return REQUIRED.every((name) => typeof members[name] === 'function');
}

/** Why Firebase messaging is unusable on this build, reported on first use. */
interface Unavailable {
  level: 'info' | 'warn';
  message: string;
}

/** The first line of an error: a native throw carries the whole Java stack. */
function firstLine(error: unknown): string {
  const text = String(error);
  const end = text.indexOf('\n');
  return end === -1 ? text : text.slice(0, end);
}

/**
 * Finds Firebase messaging's modular API, or says why it cannot be used.
 * Never throws. Called once, while this module is evaluated (see below).
 *
 * - **Evaluating RNFB without its native module throws** (`Native module
 *   RNFBAppModule not found`), so its JavaScript is only run once the native
 *   modules are known to be linked.
 * - **Reading RNFBMessagingModule throws** on a build that links Firebase
 *   without a google-services.json: it runs the module's getConstants(),
 *   which calls `FirebaseMessaging.getInstance()` ("Default FirebaseApp is not
 *   initialized").
 * - **The ES-module build** turned the `require` into esbuild's `__require`
 *   shim, which Metro does not bundle; `tsup.config.ts` keeps it a plain
 *   `require` and `scripts/check-metro-deps.mjs` checks the build.
 * - **RNFB 22.x's `default` export is the namespaced `messaging()` function**,
 *   with none of the modular functions on it, so the module's named exports
 *   are read first.
 */
function resolveFirebaseMessaging(): FirebaseMessaging | Unavailable {
  const modules = NativeModules as Record<string, unknown> | undefined;
  let missing: string[];
  try {
    missing = NATIVE_MODULES.filter((name) => modules?.[name] == null);
  } catch (error) {
    return {
      level: 'info',
      message:
        'Firebase messaging is linked but not configured (no google-services.json); ' +
        `Android push is off: ${firstLine(error)}`
    };
  }
  if (missing.length > 0) {
    return {
      level: 'info',
      message:
        `Firebase messaging is not linked (${missing.join(', ')} missing); Android push is off. ` +
        'Install @react-native-firebase/app and @react-native-firebase/messaging and rebuild.'
    };
  }

  let loaded: unknown;
  try {
    loaded = require('@react-native-firebase/messaging');
  } catch (error) {
    return {
      level: 'warn',
      message: `Firebase messaging failed to load; Android push is off: ${firstLine(error)}`
    };
  }

  const namespace = loaded as { default?: unknown } | undefined;
  for (const candidate of [namespace, namespace?.default]) {
    if (hasModularApi(candidate)) {
      return candidate;
    }
  }
  return {
    level: 'warn',
    message:
      'Firebase messaging has no modular API (getMessaging, onMessage, ...); Android push is ' +
      'off. This package needs @react-native-firebase/messaging 22 or later.'
  };
}

/**
 * Resolved while this module is evaluated, not when push is first used.
 *
 * Metro reports a throw from a module loaded *outside* another module's load
 * as a fatal error through `ErrorUtils`, before the caller's `catch` runs:
 * `guardedLoadModule` catches it itself. A `require` from a later call, such
 * as `watchPushToken` in a React effect, is outside every load, so a release
 * build died ("Requiring unknown module", FATAL EXCEPTION) however the call was
 * wrapped. During this module's own evaluation Metro is already inside a
 * guard, so the throw reaches the `catch` above and push is simply off. iOS
 * never evaluates Firebase: PushKit owns push there.
 */
const resolved: FirebaseMessaging | Unavailable | undefined =
  Platform.OS === 'android' ? resolveFirebaseMessaging() : undefined;

let reported = false;

/**
 * Firebase messaging's modular API, or undefined when it cannot be used
 * (always, on iOS). Never throws, and never loads a module: see `resolved`.
 *
 * The reason push is off is logged once, on first use rather than during
 * evaluation, so the app's own logger configuration, set in its entry file
 * after the imports, applies to it.
 */
export function loadFirebaseMessaging(): FirebaseMessaging | undefined {
  if (resolved === undefined || hasModularApi(resolved)) {
    return resolved;
  }
  if (!reported) {
    reported = true;
    logger[resolved.level](resolved.message);
  }
  return undefined;
}

/**
 * The default app's messaging instance, or undefined when there is none.
 *
 * RNFB throws `No Firebase App '[DEFAULT]' has been created` on a build that
 * links Firebase without a google-services.json. That throw reached the entry
 * file through `registerAndroidCallPush()`, before `registerRootComponent`.
 */
export function getMessagingInstance(firebase: FirebaseMessaging): unknown {
  try {
    return firebase.getMessaging();
  } catch (error) {
    logger.warn(`Firebase has no default app; Android push is off: ${String(error)}`);
    return undefined;
  }
}
