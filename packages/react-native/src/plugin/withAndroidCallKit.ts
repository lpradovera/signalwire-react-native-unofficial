import { AndroidConfig, withAndroidManifest } from 'expo/config-plugins';

import type { ConfigPlugin } from 'expo/config-plugins';

export interface AndroidOptions {
  enableCallKit: boolean;
}

const BASE_PERMISSIONS = [
  'android.permission.RECORD_AUDIO',
  'android.permission.CAMERA',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.WAKE_LOCK',
  // Android 12+ shows no Bluetooth device to an app without it, so
  // incall-manager never starts its Bluetooth manager and a headset is never
  // a route. Requested at runtime by the CallKit bridge.
  'android.permission.BLUETOOTH_CONNECT'
];

const CALLKIT_PERMISSIONS = [
  'android.permission.MANAGE_OWN_CALLS',
  'android.permission.READ_PHONE_STATE',
  // ConnectionService reads the phone account while building an outgoing
  // connection. callkeep declares this too, but declaring it here keeps the
  // requirement visible where the rest of them are.
  'android.permission.READ_PHONE_NUMBERS',
  // For the ConnectionService's 'phoneCall' foreground-service type.
  'android.permission.FOREGROUND_SERVICE_PHONE_CALL'
];

/** callkeep's ConnectionService, which Telecom binds to place and receive calls. */
const CONNECTION_SERVICE = 'io.wazo.callkeep.VoiceConnectionService';

/**
 * The ConnectionService's foreground-service types.
 *
 * callkeep starts it with `startForeground(id, notification)`, so every type
 * declared here applies at once, and on Android 14+ the start is refused
 * outright if any one of them is not allowed. 'camera' was declared without
 * FOREGROUND_SERVICE_CAMERA, and even with it would need a CAMERA grant that
 * an audio-only app never asks for:
 *
 *   SecurityException: Starting FGS with type camera ... requires permissions:
 *   [android.permission.FOREGROUND_SERVICE_CAMERA] any of [android.permission.CAMERA]
 *
 * so no call ever ran as a foreground service. 'phoneCall' is the type for a
 * ConnectionService call (MANAGE_OWN_CALLS) and 'microphone' keeps the
 * microphone usable while the app is in the background. Each needs its
 * FOREGROUND_SERVICE_* permission, declared above.
 */
const CONNECTION_SERVICE_TYPES = 'phoneCall|microphone';

/**
 * Declares callkeep's ConnectionService in the app manifest.
 *
 * callkeep ships a library manifest with permissions only — the service
 * declaration is left to the app, and its README asks you to paste it in.
 * Without it Telecom refuses the phone account outright:
 *
 *   SecurityException: Registering a PhoneAccount requires either: (1) The
 *   Service definition requires that the ConnectionService is guarded with
 *   the BIND_TELECOM_CONNECTION_SERVICE permission
 *
 * which is thrown during setup and takes the app down on every launch. An SDK
 * whose Android side cannot start is not much of an SDK, so the plugin does it.
 *
 * `android:permission` here is a guard, not a request: it says only Telecom,
 * which holds that signature permission, may bind this service. It is not a
 * `uses-permission` — an app cannot hold it, and asking for it does nothing.
 */
function withConnectionService(config: Parameters<ConfigPlugin>[0]) {
  return withAndroidManifest(config, (manifestConfig) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifestConfig.modResults);
    application.service = application.service ?? [];

    const existing = application.service.find(
      (service) => service.$?.['android:name'] === CONNECTION_SERVICE
    );
    if (existing) {
      // An earlier prebuild (or the app) declared it: keep it, with types that start.
      existing.$ = { ...existing.$, 'android:foregroundServiceType': CONNECTION_SERVICE_TYPES };
      return manifestConfig;
    }

    application.service.push({
      $: {
        'android:name': CONNECTION_SERVICE,
        'android:label': 'Calls',
        'android:permission': 'android.permission.BIND_TELECOM_CONNECTION_SERVICE',
        'android:foregroundServiceType': CONNECTION_SERVICE_TYPES,
        // Telecom lives in another process and must be able to bind it.
        'android:exported': 'true'
      },
      'intent-filter': [
        { action: [{ $: { 'android:name': 'android.telecom.ConnectionService' } }] }
      ]
    } as never);

    return manifestConfig;
  });
}

/** Adds the permissions and service declaration ConnectionService requires. */
export const withAndroidCallKit: ConfigPlugin<AndroidOptions> = (config, options) => {
  const required = options.enableCallKit
    ? [...BASE_PERMISSIONS, ...CALLKIT_PERMISSIONS]
    : BASE_PERMISSIONS;

  const existing = config.android?.permissions ?? [];
  const withPermissions = {
    ...config,
    android: { ...config.android, permissions: [...new Set([...existing, ...required])] }
  };

  return options.enableCallKit ? withConnectionService(withPermissions) : withPermissions;
};
