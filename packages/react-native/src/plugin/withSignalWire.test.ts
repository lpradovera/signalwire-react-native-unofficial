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
  withXcodeProject: (config: Record<string, unknown>) => config
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

  it('adds the ConnectionService permission only when CallKit is enabled', () => {
    expect(applyPlugin({ enableCallKit: false }).android?.permissions ?? []).not.toContain(
      'android.permission.BIND_TELECOM_CONNECTION_SERVICE'
    );
    expect(applyPlugin({ enableCallKit: true }).android?.permissions ?? []).toContain(
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
});
