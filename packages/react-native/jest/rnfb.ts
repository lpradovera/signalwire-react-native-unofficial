/**
 * The real React Native Firebase messaging JavaScript, with only its native
 * side stubbed.
 *
 * The suite used to mock Firebase as a flat object of named functions, the one
 * shape the loader happened to accept. RNFB 22.x (the version the example pins)
 * hands `require` a module whose `default` is the namespaced `messaging()`
 * function, so the loader took that, found no `getMessaging`, and turned
 * Android push off, while every test stayed green. These helpers load the
 * package as installed, so the tests see what an app sees.
 *
 * RNFB is a peer of this package, installed in the example workspace;
 * `jest.config.js` maps the package name to it.
 */

/** What `FirebaseApp.getApps()` reports natively for a build with a google-services.json. */
export const DEFAULT_FIREBASE_APP = {
  appConfig: { name: '[DEFAULT]', automaticDataCollectionEnabled: true },
  options: { appId: '1:1:android:1', projectId: 'p', apiKey: 'k', messagingSenderId: '1' }
};

export interface RnfbNativeState {
  /** Firebase apps the native side reports; empty when no google-services.json was processed. */
  apps: unknown[];
  /** Native messaging calls, in order. */
  calls: string[];
}

/**
 * Installs RNFBAppModule and RNFBMessagingModule on `NativeModules`, as a
 * build that links Firebase has them.
 */
export function installRnfbNatives(
  nativeModules: Record<string, unknown>,
  state: RnfbNativeState
): void {
  nativeModules.RNFBAppModule = {
    get NATIVE_FIREBASE_APPS() {
      return state.apps;
    },
    FIREBASE_RAW_JSON: '{}',
    addListener: () => undefined,
    removeListeners: () => undefined,
    eventsAddListener: (name: string) => state.calls.push(`eventsAddListener:${name}`),
    eventsRemoveListener: () => undefined,
    eventsNotifyReady: () => undefined,
    eventsGetListeners: async () => ({}),
    eventsPing: async () => ({})
  };
  nativeModules.RNFBMessagingModule = {
    isAutoInitEnabled: true,
    isDeviceRegisteredForRemoteMessages: true,
    isNotificationDelegationEnabled: false,
    isDeliveryMetricsExportToBigQueryEnabled: false,
    getToken: async () => {
      state.calls.push('getToken');
      return 'fcm-token';
    },
    requestPermission: async () => {
      state.calls.push('requestPermission');
      return 1;
    },
    hasPermission: async () => 1,
    signalBackgroundMessageHandlerSet: () => state.calls.push('signalBackgroundMessageHandlerSet'),
    addListener: () => undefined,
    removeListeners: () => undefined
  };
}
