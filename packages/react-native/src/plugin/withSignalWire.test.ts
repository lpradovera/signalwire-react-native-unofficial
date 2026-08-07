import withSignalWire from './withSignalWire';

import type { SignalWirePluginOptions } from './withSignalWire';

// The iOS half runs inside `withInfoPlist`, an Expo mod that only executes
// during a real prebuild. Replace it with a synchronous stand-in that applies
// the same mutation to `config.ios.infoPlist`, so the plugin's own logic is
// what gets tested.
jest.mock('@expo/config-plugins', () => ({
  withInfoPlist: (
    config: Record<string, unknown>,
    action: (c: { modResults: Record<string, unknown> }) => { modResults: Record<string, unknown> }
  ) => {
    const ios = (config.ios ?? {}) as { infoPlist?: Record<string, unknown> };
    const result = action({ modResults: ios.infoPlist ?? {} });
    return { ...config, ios: { ...ios, infoPlist: result.modResults } };
  },
  // The VoIP mods write a file and edit the Xcode project — both are
  // filesystem work with no meaning outside a real prebuild, so they pass the
  // config through untouched here. `verify:prebuild` asserts their real
  // behaviour against actual generated output.
  withDangerousMod: (config: Record<string, unknown>) => config,
  withXcodeProject: (config: Record<string, unknown>) => config,
  AndroidConfig: {
    Manifest: {
      getMainApplicationOrThrow: (manifest: { application?: unknown[] }) => {
        manifest.application = manifest.application ?? [{}];
        return manifest.application[0];
      }
    }
  },
  withAndroidManifest: (
    config: Record<string, unknown>,
    action: (c: { modResults: Record<string, unknown> }) => { modResults: Record<string, unknown> }
  ) => {
    const manifest = (config.__manifest as Record<string, unknown>) ?? { application: [{}] };
    const result = action({ modResults: manifest });
    return { ...config, __manifest: result.modResults };
  },
  withEntitlementsPlist: (
    config: Record<string, unknown>,
    action: (c: { modResults: Record<string, unknown> }) => { modResults: Record<string, unknown> }
  ) => {
    const ios = (config.ios ?? {}) as { entitlements?: Record<string, unknown> };
    const result = action({ modResults: ios.entitlements ?? {} });
    return { ...config, ios: { ...ios, entitlements: result.modResults } };
  }
}));

interface TestConfig {
  name: string;
  slug: string;
  ios?: { infoPlist?: Record<string, unknown> };
  android?: { permissions?: string[] };
}

function baseConfig(): TestConfig {
  return { name: 'Demo', slug: 'demo', ios: {}, android: {} };
}

function applyPlugin(options?: SignalWirePluginOptions): TestConfig {
  return withSignalWire(baseConfig() as never, options) as unknown as TestConfig;
}

describe('withSignalWire', () => {
  it('adds the iOS microphone and camera usage strings', () => {
    const config = applyPlugin();
    expect(config.ios?.infoPlist?.NSMicrophoneUsageDescription).toEqual(expect.any(String));
    expect(config.ios?.infoPlist?.NSCameraUsageDescription).toEqual(expect.any(String));
  });

  it('honours custom permission copy', () => {
    const config = applyPlugin({ microphonePermission: 'Mic for calls' });
    expect(config.ios?.infoPlist?.NSMicrophoneUsageDescription).toBe('Mic for calls');
  });

  it('adds the audio background mode', () => {
    expect(applyPlugin().ios?.infoPlist?.UIBackgroundModes).toContain('audio');
  });

  it('adds the voip background mode only when VoIP push is enabled', () => {
    expect(applyPlugin({ enableVoipPush: false }).ios?.infoPlist?.UIBackgroundModes).not.toContain(
      'voip'
    );
    expect(applyPlugin({ enableVoipPush: true }).ios?.infoPlist?.UIBackgroundModes).toContain(
      'voip'
    );
  });

  it('adds the Android call permissions', () => {
    expect(applyPlugin().android?.permissions ?? []).toEqual(
      expect.arrayContaining([
        'android.permission.RECORD_AUDIO',
        'android.permission.CAMERA',
        'android.permission.FOREGROUND_SERVICE',
        'android.permission.FOREGROUND_SERVICE_MICROPHONE',
        'android.permission.POST_NOTIFICATIONS'
      ])
    );
  });

  it('adds the call-management permissions only when CallKit is enabled', () => {
    expect(applyPlugin({ enableCallKit: false }).android?.permissions ?? []).not.toContain(
      'android.permission.MANAGE_OWN_CALLS'
    );
    expect(applyPlugin({ enableCallKit: true }).android?.permissions ?? []).toContain(
      'android.permission.MANAGE_OWN_CALLS'
    );
  });

  it('never requests BIND_TELECOM_CONNECTION_SERVICE as a permission', () => {
    // It is a signature permission held by Telecom; an app cannot be granted
    // it and asking changes nothing. What Telecom actually checks is the
    // `android:permission` guard on the service declaration — asserted above.
    expect(applyPlugin({ enableCallKit: true }).android?.permissions ?? []).not.toContain(
      'android.permission.BIND_TELECOM_CONNECTION_SERVICE'
    );
  });

  it('does not duplicate permissions when applied twice', () => {
    const once = applyPlugin();
    const twice = withSignalWire(once as never, undefined) as unknown as TestConfig;
    const permissions = twice.android?.permissions ?? [];
    expect(permissions.length).toBe(new Set(permissions).size);
  });

  it('preserves background modes the app already declared', () => {
    const config = baseConfig();
    config.ios = { infoPlist: { UIBackgroundModes: ['fetch'] } };
    const result = withSignalWire(config as never, undefined) as unknown as TestConfig;
    expect(result.ios?.infoPlist?.UIBackgroundModes).toContain('fetch');
    expect(result.ios?.infoPlist?.UIBackgroundModes).toContain('audio');
  });

  it('preserves Android permissions the app already declared', () => {
    const config = baseConfig();
    config.android = { permissions: ['android.permission.VIBRATE'] };
    const result = withSignalWire(config as never, undefined) as unknown as TestConfig;
    expect(result.android?.permissions).toContain('android.permission.VIBRATE');
  });

  it('adds the push entitlement, which prebuild would otherwise wipe', () => {
    // A capability added by hand in Xcode disappears on the next prebuild.
    // Without aps-environment iOS issues no PushKit token, and the failure is
    // silent server-side: APNs keeps reporting pushes delivered.
    const result = withSignalWire({ name: 'demo', slug: 'demo' } as never, {
      enableVoipPush: true
    }) as unknown as { ios?: { entitlements?: Record<string, unknown> } };

    expect(result.ios?.entitlements?.['aps-environment']).toBe('development');
  });

  it('omits the push entitlement when VoIP push is off', () => {
    const result = withSignalWire({ name: 'demo', slug: 'demo' } as never, {
      enableVoipPush: false
    }) as unknown as { ios?: { entitlements?: Record<string, unknown> } };

    expect(result.ios?.entitlements?.['aps-environment']).toBeUndefined();
  });

  it('declares callkeep\'s ConnectionService, which Telecom requires', () => {
    // callkeep ships permissions only; without the service declaration Telecom
    // throws SecurityException on registerPhoneAccount during setup and the
    // app dies on every launch.
    const result = withSignalWire({ name: 'demo', slug: 'demo' } as never, {
      enableCallKit: true
    }) as unknown as { __manifest?: { application?: Array<{ service?: Array<{ $: Record<string, string> }> }> } };

    const service = result.__manifest?.application?.[0]?.service?.find(
      (entry) => entry.$['android:name'] === 'io.wazo.callkeep.VoiceConnectionService'
    );

    expect(service).toBeDefined();
    expect(service?.$['android:permission']).toBe(
      'android.permission.BIND_TELECOM_CONNECTION_SERVICE'
    );
    expect(service?.$['android:exported']).toBe('true');
  });

  it('omits the ConnectionService when CallKit is off', () => {
    const result = withSignalWire({ name: 'demo', slug: 'demo' } as never, {
      enableCallKit: false
    }) as unknown as { __manifest?: unknown };

    expect(result.__manifest).toBeUndefined();
  });
});
