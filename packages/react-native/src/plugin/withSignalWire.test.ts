import withSignalWire from './withSignalWire';

import type { SignalWirePluginOptions } from './withSignalWire';

// The iOS half runs inside `withInfoPlist`, an Expo mod that only executes
// during a real prebuild. Replace it with a synchronous stand-in that applies
// the same mutation to `config.ios.infoPlist`, so the plugin's own logic is
// what gets tested.
jest.mock('expo/config-plugins', () => ({
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
  // `__voipHook` marks that the hook's file-writing mod was registered.
  withDangerousMod: (config: Record<string, unknown>) => ({ ...config, __voipHook: true }),
  withXcodeProject: (config: Record<string, unknown>) => config,
  WarningAggregator: { addWarningIOS: jest.fn() },
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

let mockCallKeepInstalled = true;
jest.mock('./callKeep', () => ({
  isCallKeepInstalled: jest.fn(() => mockCallKeepInstalled)
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
  beforeEach(() => {
    mockCallKeepInstalled = true;
  });

  it('adds the iOS microphone and camera usage strings', () => {
    const config = applyPlugin();
    expect(config.ios?.infoPlist?.NSMicrophoneUsageDescription).toEqual(expect.any(String));
    expect(config.ios?.infoPlist?.NSCameraUsageDescription).toEqual(expect.any(String));
  });

  it('honours custom permission copy', () => {
    const config = applyPlugin({ microphonePermission: 'Mic for calls' });
    expect(config.ios?.infoPlist?.NSMicrophoneUsageDescription).toBe('Mic for calls');
  });

  it("keeps the app's own usage strings when no option is given", () => {
    // Overwriting them replaced the text from ios.infoPlist (or from a plugin
    // whose mod ran earlier) with the generic default.
    const config = withSignalWire(
      {
        ...baseConfig(),
        ios: {
          infoPlist: {
            NSMicrophoneUsageDescription: 'Custom mic text',
            NSCameraUsageDescription: 'Custom camera text'
          }
        }
      } as never,
      undefined
    ) as unknown as TestConfig;

    expect(config.ios?.infoPlist?.NSMicrophoneUsageDescription).toBe('Custom mic text');
    expect(config.ios?.infoPlist?.NSCameraUsageDescription).toBe('Custom camera text');
  });

  it('lets a plugin option win over an existing usage string', () => {
    const config = withSignalWire(
      { ...baseConfig(), ios: { infoPlist: { NSMicrophoneUsageDescription: 'Old' } } } as never,
      { microphonePermission: 'Mic for calls' }
    ) as unknown as TestConfig;

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

  it('declares the call intents Recents and Siri hand the app', () => {
    expect(applyPlugin().ios?.infoPlist?.NSUserActivityTypes).toEqual(
      expect.arrayContaining(['INStartCallIntent', 'INStartAudioCallIntent', 'INStartVideoCallIntent'])
    );
  });

  it('keeps activity types the app already declared, and adds none without CallKit', () => {
    const config = withSignalWire(
      { ...baseConfig(), ios: { infoPlist: { NSUserActivityTypes: ['com.demo.view'] } } } as never,
      undefined
    ) as unknown as TestConfig;
    expect(config.ios?.infoPlist?.NSUserActivityTypes).toEqual(
      expect.arrayContaining(['com.demo.view', 'INStartCallIntent'])
    );
    expect(applyPlugin({ enableCallKit: false }).ios?.infoPlist?.NSUserActivityTypes).toBeUndefined();
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

  it("declares a foreground-service permission for every type the ConnectionService declares", () => {
    // callkeep starts the service with startForeground(id, notification), so
    // every manifest type applies. Android 14+ refuses the whole service when
    // one type lacks its FOREGROUND_SERVICE_<TYPE> permission (or, for
    // camera, a CAMERA grant an audio call may never have): the 'camera' type
    // this used to declare without FOREGROUND_SERVICE_CAMERA did exactly that.
    const result = withSignalWire({ name: 'demo', slug: 'demo' } as never, {
      enableCallKit: true
    }) as unknown as {
      android?: { permissions?: string[] };
      __manifest?: { application?: Array<{ service?: Array<{ $: Record<string, string> }> }> };
    };
    const service = result.__manifest?.application?.[0]?.service?.find(
      (entry) => entry.$['android:name'] === 'io.wazo.callkeep.VoiceConnectionService'
    );
    const types = (service?.$['android:foregroundServiceType'] ?? '').split('|');

    expect(types).toEqual(['phoneCall', 'microphone']);
    for (const type of types) {
      const permission = `android.permission.FOREGROUND_SERVICE_${type
        .replace(/([a-z])([A-Z])/g, '$1_$2')
        .toUpperCase()}`;
      expect(result.android?.permissions).toContain(permission);
    }
  });

  it('corrects the service type of a ConnectionService an earlier prebuild declared', () => {
    const config = {
      name: 'demo',
      slug: 'demo',
      __manifest: {
        application: [
          {
            service: [
              {
                $: {
                  'android:name': 'io.wazo.callkeep.VoiceConnectionService',
                  'android:foregroundServiceType': 'camera|microphone'
                }
              }
            ]
          }
        ]
      }
    };
    const result = withSignalWire(config as never, { enableCallKit: true }) as unknown as {
      __manifest: { application: Array<{ service: Array<{ $: Record<string, string> }> }> };
    };
    const services = result.__manifest.application[0]!.service;
    expect(services).toHaveLength(1);
    expect(services[0]!.$['android:foregroundServiceType']).toBe('phoneCall|microphone');
  });

  it('declares BLUETOOTH_CONNECT, without which Android 12+ hides every Bluetooth headset', () => {
    expect(applyPlugin().android?.permissions).toContain('android.permission.BLUETOOTH_CONNECT');
  });

  it('omits the ConnectionService when CallKit is off', () => {
    const result = withSignalWire({ name: 'demo', slug: 'demo' } as never, {
      enableCallKit: false
    }) as unknown as { __manifest?: unknown };

    expect(result.__manifest).toBeUndefined();
  });

  describe('iOS VoIP push and its dependencies (plugins-6)', () => {
    type IosResult = TestConfig & {
      __voipHook?: boolean;
      ios?: { infoPlist?: Record<string, unknown>; entitlements?: Record<string, unknown> };
    };
    const apply = (options?: Record<string, unknown>): IosResult =>
      withSignalWire(
        { ...baseConfig(), _internal: { projectRoot: '/app' } } as never,
        options as never
      ) as unknown as IosResult;

    it('generates the hook by default when callkeep is installed', () => {
      const result = apply();
      expect(result.__voipHook).toBe(true);
      expect(result.ios?.infoPlist?.UIBackgroundModes).toContain('voip');
      expect(result.ios?.entitlements?.['aps-environment']).toBe('development');
    });

    it('turns iOS VoIP push off by default when CallKit is off', () => {
      // The hook reports every push to CallKit through callkeep; with
      // enableCallKit: false the app asked for no native call UI.
      const result = apply({ enableCallKit: false });
      expect(result.__voipHook).toBeUndefined();
      expect(result.ios?.infoPlist?.UIBackgroundModes).not.toContain('voip');
      expect(result.ios?.entitlements?.['aps-environment']).toBeUndefined();
    });

    it('still honours an explicit enableVoipPush: true alongside enableCallKit: false', () => {
      expect(apply({ enableCallKit: false, enableVoipPush: true }).__voipHook).toBe(true);
    });

    it('skips the hook, with a warning, when callkeep is not installed', () => {
      // The hook imports RNCallKeep.h: generated without callkeep, the iOS
      // build fails with "'RNCallKeep.h' file not found".
      mockCallKeepInstalled = false;
      const { WarningAggregator } = jest.requireMock('expo/config-plugins') as {
        WarningAggregator: { addWarningIOS: jest.Mock };
      };
      WarningAggregator.addWarningIOS.mockClear();

      const result = apply();
      expect(result.__voipHook).toBeUndefined();
      expect(result.ios?.infoPlist?.UIBackgroundModes).not.toContain('voip');
      expect(WarningAggregator.addWarningIOS).toHaveBeenCalledWith(
        '@signalwire/react-native',
        expect.stringContaining('Install @signalwire/react-native-callkeep')
      );
    });

    it('fails prebuild when VoIP push is asked for without callkeep', () => {
      mockCallKeepInstalled = false;
      expect(() => apply({ enableVoipPush: true })).toThrow(
        /Install @signalwire\/react-native-callkeep \(or stock react-native-callkeep\)/
      );
    });

    it('rejects an option name it does not know', () => {
      // A typo such as enableVoIPPush silently left VoIP push on.
      expect(() => apply({ enableVoIPPush: false })).toThrow(/enableVoIPPush/);
    });

    it('rejects an option of the wrong type', () => {
      expect(() => apply({ enableVoipPush: 'false' })).toThrow(/enableVoipPush/);
      expect(() => apply({ microphonePermission: 42 })).toThrow(/microphonePermission/);
    });
  });
});
