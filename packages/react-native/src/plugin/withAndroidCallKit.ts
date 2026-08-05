import type { ConfigPlugin } from '@expo/config-plugins';

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
  'android.permission.WAKE_LOCK'
];

const CALLKIT_PERMISSIONS = [
  'android.permission.BIND_TELECOM_CONNECTION_SERVICE',
  'android.permission.MANAGE_OWN_CALLS',
  'android.permission.READ_PHONE_STATE'
];

/** Adds the permissions ConnectionService and foreground audio require. */
export const withAndroidCallKit: ConfigPlugin<AndroidOptions> = (config, options) => {
  const required = options.enableCallKit
    ? [...BASE_PERMISSIONS, ...CALLKIT_PERMISSIONS]
    : BASE_PERMISSIONS;

  const existing = config.android?.permissions ?? [];

  return {
    ...config,
    android: { ...config.android, permissions: [...new Set([...existing, ...required])] }
  };
};
