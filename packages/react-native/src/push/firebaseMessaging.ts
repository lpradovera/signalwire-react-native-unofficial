import { NativeModules } from 'react-native';

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

/**
 * Loads Firebase messaging's modular API, or returns undefined when it cannot
 * be used. Never throws.
 *
 * Three things make this harder than an import:
 *
 * - **Evaluating RNFB without its native module throws** (`Native module
 *   RNFBAppModule not found`), which a static import ran at entry-file load on
 *   a build without Firebase (the example's iOS build), before any guard: the
 *   app died with `"main" has not been registered`. So it is required lazily,
 *   and only once the native modules are known to be linked: a throw while
 *   Metro loads a module outside another module's load is reported as a fatal
 *   error, which ends a release build, so catching it is not enough.
 * - **The ES-module build** turned the lazy `require` into esbuild's
 *   `__require` shim, which Metro does not bundle; `tsup.config.ts` keeps it a
 *   plain `require` and `scripts/check-metro-deps.mjs` checks the build.
 * - **RNFB 22.x's `default` export is the namespaced `messaging()` function**,
 *   with none of the modular functions on it. Preferring `default` turned push
 *   off on exactly the version the example pins; the modular functions are the
 *   module's named exports, and are read from there first.
 */
export function loadFirebaseMessaging(): FirebaseMessaging | undefined {
  const modules = NativeModules as Record<string, unknown> | undefined;
  const missing = NATIVE_MODULES.filter((name) => modules?.[name] == null);
  if (missing.length > 0) {
    logger.debug(
      `Firebase messaging is not linked (${missing.join(', ')} missing); Android push is off. ` +
        'Install @react-native-firebase/app and @react-native-firebase/messaging and rebuild.'
    );
    return undefined;
  }

  let loaded: unknown;
  try {
    loaded = require('@react-native-firebase/messaging');
  } catch (error) {
    logger.warn(`Firebase messaging failed to load; Android push is off: ${String(error)}`);
    return undefined;
  }

  const namespace = loaded as { default?: unknown } | undefined;
  for (const candidate of [namespace, namespace?.default]) {
    if (hasModularApi(candidate)) {
      return candidate;
    }
  }
  logger.warn(
    'Firebase messaging has no modular API (getMessaging, onMessage, ...); Android push is off. ' +
      'This package needs @react-native-firebase/messaging 22 or later.'
  );
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
