import { WarningAggregator } from 'expo/config-plugins';

import { isCallKeepInstalled } from './callKeep';
import { withAndroidCallKit } from './withAndroidCallKit';
import { withCallKitActivity } from './withCallKitActivity';
import { withIosCallKit } from './withIosCallKit';
import { withSiriCallIntent } from './withSiriCallIntent';
import { withVoipPush } from './withVoipPush';

import type { ConfigPlugin } from 'expo/config-plugins';

export interface SignalWirePluginOptions {
  /**
   * iOS `NSMicrophoneUsageDescription`. Without it, a string the app already
   * sets (`ios.infoPlist`, or another plugin) is kept, else a generic default.
   */
  microphonePermission?: string;
  /** iOS `NSCameraUsageDescription`, kept or defaulted the same way. */
  cameraPermission?: string;
  /**
   * Add ConnectionService / CallKit permissions, and on iOS the Recents / Siri
   * call-back forwarder and its `NSUserActivityTypes`. Default `true`.
   */
  enableCallKit?: boolean;
  /**
   * Generate the iOS PushKit hook and add the `voip` background mode and push
   * entitlement. Default: on when `enableCallKit` is on and
   * callkeep (`@signalwire/react-native-callkeep` or stock `react-native-callkeep`)
   * is installed, since the hook reports every push
   * to CallKit through it. `true` without callkeep fails prebuild.
   */
  enableVoipPush?: boolean;
  /**
   * iOS: let Siri place calls through the app ("call <name> with <app>", "call
   * back"). Adds `INStartCallIntent` to `INIntentsSupported`,
   * `NSSiriUsageDescription`, the `com.apple.developer.siri` entitlement, and
   * generates `SignalWireSiriCallIntent.m`, the AppDelegate's in-app intent
   * handler. Default `false`: the entitlement needs a paid Apple Developer
   * Program team (a free personal team cannot sign it), and Siri asks the app
   * only when it supports multiple scenes. Needs `enableCallKit` and callkeep:
   * the call is placed through the Recents call-back path.
   */
  enableSiri?: boolean;
  /** iOS `NSSiriUsageDescription`, with `enableSiri`; kept or defaulted like the others. */
  siriPermission?: string;
}

const OPTION_TYPES: Record<keyof SignalWirePluginOptions, 'string' | 'boolean'> = {
  microphonePermission: 'string',
  cameraPermission: 'string',
  enableCallKit: 'boolean',
  enableVoipPush: 'boolean',
  enableSiri: 'boolean',
  siriPermission: 'string'
};

/** Rejects misspelt or mistyped options, which would otherwise fall back to a default silently. */
function validateOptions(options: unknown): SignalWirePluginOptions {
  if (options === undefined || options === null) {
    return {};
  }
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('@signalwire/react-native: plugin options must be an object.');
  }
  for (const [key, value] of Object.entries(options)) {
    const expected = OPTION_TYPES[key as keyof SignalWirePluginOptions];
    if (!expected) {
      throw new Error(
        `@signalwire/react-native: unknown plugin option "${key}". ` +
          `Known options: ${Object.keys(OPTION_TYPES).join(', ')}.`
      );
    }
    if (value !== undefined && typeof value !== expected) {
      throw new Error(`@signalwire/react-native: plugin option "${key}" must be a ${expected}.`);
    }
  }
  return options as SignalWirePluginOptions;
}

/**
 * Expo config plugin for `@signalwire/react-native`.
 *
 * ```json
 * { "plugins": [["@signalwire/react-native", { "enableVoipPush": true }]] }
 * ```
 *
 * With `enableVoipPush` it also generates the native PushKit hook, as a
 * separate Objective-C category rather than a patch to `AppDelegate.swift`.
 * Reporting a cold-start VoIP push to CallKit must happen in native code — the
 * JS bundle is not running yet and iOS kills an app that does not report the
 * call almost immediately — but regex-patching Expo's Swift template fails
 * silently when the template changes, and Swift cannot import RNCallKeep
 * (react-native-callkeep#856). A category avoids both problems and survives
 * `expo prebuild` regenerating the AppDelegate.
 *
 * With `enableCallKit` it generates a second category the same way, which
 * forwards `application:continueUserActivity:` (Recents and Siri call-backs,
 * `INStartCallIntent`) to RNCallKeep, and declares the call intents in
 * `NSUserActivityTypes`.
 *
 * With `enableSiri` it generates a third, `SignalWireSiriCallIntent.m`, which
 * gives the AppDelegate `application:handlerForIntent:` for Siri's
 * `INStartCallIntent`, and adds the intent, the Siri usage string and the Siri
 * entitlement.
 */
const withSignalWire: ConfigPlugin<SignalWirePluginOptions | undefined> = (config, options) => {
  const {
    microphonePermission,
    cameraPermission,
    enableCallKit = true,
    enableVoipPush: requestedVoipPush,
    enableSiri = false,
    siriPermission
  } = validateOptions(options);

  const projectRoot = (config as { _internal?: { projectRoot?: unknown } })._internal?.projectRoot;
  // Prebuild always sets it; without it there is nothing to check against.
  const callKeep = typeof projectRoot === 'string' ? isCallKeepInstalled(projectRoot) : true;
  const enableVoipPush = resolveVoipPush(callKeep, enableCallKit, requestedVoipPush);
  if (enableSiri && !(enableCallKit && callKeep)) {
    throw new Error(
      '@signalwire/react-native: enableSiri needs enableCallKit and callkeep: Siri opens the app with the ' +
        'call, which reaches startCallRequested$ through callkeep, like a Recents call-back. Install ' +
        '@signalwire/react-native-callkeep, or leave enableSiri off.'
    );
  }

  const withIos = withIosCallKit(config, {
    microphonePermission,
    cameraPermission,
    enableVoipPush,
    enableCallKit,
    enableSiri,
    siriPermission
  });

  // Recents and Siri call-backs: the AppDelegate hands INStartCallIntent to
  // RNCallKeep, which only a generated Objective-C file can reach. That file
  // imports RNCallKeep.h too, so without callkeep it is not generated either.
  const withActivity = enableCallKit && callKeep ? withCallKitActivity(withIos) : withIos;
  // Siri's start-call request: the AppDelegate's in-app intent handler.
  const withSiri = enableSiri ? withSiriCallIntent(withActivity) : withActivity;
  const withPush = enableVoipPush ? withVoipPush(withSiri) : withSiri;

  return withAndroidCallKit(withPush, { enableCallKit });
};

/**
 * Decides whether the iOS PushKit hook is generated.
 *
 * The hook imports `RNCallKeep.h` and reports every push through callkeep, so
 * it cannot build without callkeep, an optional peer. Generating it anyway
 * broke the iOS build of every app that added the plugin without callkeep,
 * and `enableCallKit: false` left CallKit reporting on for iOS.
 */
function resolveVoipPush(
  callKeep: boolean,
  enableCallKit: boolean,
  requested: boolean | undefined
): boolean {
  if (requested === false) {
    return false;
  }

  if (requested === true) {
    if (!callKeep) {
      throw new Error(
        '@signalwire/react-native: enableVoipPush needs callkeep, which the generated PushKit hook ' +
          'reports calls through. Install @signalwire/react-native-callkeep (or stock ' +
          'react-native-callkeep), or set enableVoipPush: false.'
      );
    }
    return true;
  }

  if (!enableCallKit) {
    return false;
  }
  if (!callKeep) {
    WarningAggregator.addWarningIOS(
      '@signalwire/react-native',
      'callkeep is not installed (neither @signalwire/react-native-callkeep nor react-native-callkeep), ' +
        'so the VoIP push hook was not generated and the app will not ring for pushed calls. Install ' +
        '@signalwire/react-native-callkeep to enable VoIP push, or set enableVoipPush: false.'
    );
    return false;
  }
  return true;
}

export default withSignalWire;
