#!/usr/bin/env node
/**
 * Verifies the Expo config plugin against a real `expo prebuild`.
 *
 * The unit tests in `withSignalWire.test.ts` mock `withInfoPlist`, so they prove
 * the plugin's own logic but not that Expo's mod pipeline applies it. This runs
 * the real thing and asserts on the generated native files.
 *
 * Needs no Xcode, Android SDK, or CocoaPods — prebuild only generates sources.
 *
 * Usage: node scripts/verify-prebuild.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const example = join(root, 'example');

const IOS_PLIST = 'ios/SignalWireRNExample/Info.plist';
const IOS_VOIP_SOURCE = 'ios/SignalWireRNExample/SignalWireVoipPush.m';
const IOS_PBXPROJ = 'ios/SignalWireRNExample.xcodeproj/project.pbxproj';
const IOS_ENTITLEMENTS = 'ios/SignalWireRNExample/SignalWireRNExample.entitlements';
const ANDROID_MANIFEST = 'android/app/src/main/AndroidManifest.xml';

const EXPECTED_ANDROID_PERMISSIONS = [
  'android.permission.RECORD_AUDIO',
  'android.permission.CAMERA',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.WAKE_LOCK',
  'android.permission.BIND_TELECOM_CONNECTION_SERVICE',
  'android.permission.MANAGE_OWN_CALLS',
  'android.permission.READ_PHONE_STATE'
];

const EXPECTED_PLIST_ENTRIES = [
  'NSMicrophoneUsageDescription',
  'NSCameraUsageDescription',
  '<string>audio</string>',
  '<string>voip</string>'
];

const failures = [];

function prebuild(platform) {
  process.stdout.write(`  prebuild ${platform}… `);
  execFileSync('npx', ['expo', 'prebuild', '--platform', platform, '--no-install', '--clean'], {
    cwd: example,
    stdio: 'pipe',
    env: {
      ...process.env,
      // This check is about *our* config plugin. Firebase's plugin demands an
      // iOS GoogleService-Info.plist whenever it is applied — even for an
      // Android-only setup, and even when prebuilding iOS, which uses PushKit
      // and no Firebase at all. Leaving it enabled makes this check fail for
      // a reason that has nothing to do with what it verifies.
      GOOGLE_SERVICES_JSON: '',
      EXPO_NO_DOTENV: '1'
    }
  });
  process.stdout.write('ok\n');
}

function check(label, contents, needles) {
  for (const needle of needles) {
    if (!contents.includes(needle)) {
      failures.push(`${label}: missing ${needle}`);
    }
  }
}

console.log('Verifying the Expo config plugin against a real prebuild:');

prebuild('android');
check(
  ANDROID_MANIFEST,
  readFileSync(join(example, ANDROID_MANIFEST), 'utf8'),
  EXPECTED_ANDROID_PERMISSIONS
);

prebuild('ios');
check(IOS_PLIST, readFileSync(join(example, IOS_PLIST), 'utf8'), EXPECTED_PLIST_ENTRIES);

// The VoIP hook is native code that only runs if Xcode compiles it. Writing
// the file is not enough: an unreferenced .m is silently ignored, and the
// failure shows up much later as "pushes do nothing".
check(IOS_VOIP_SOURCE, readFileSync(join(example, IOS_VOIP_SOURCE), 'utf8'), [
  'PKPushRegistry',
  'reportNewIncomingCall',
  'call_id',
  'SignalWireVoipTokenNotification'
]);
check(IOS_PBXPROJ, readFileSync(join(example, IOS_PBXPROJ), 'utf8'), [
  'SignalWireVoipPush.m in Sources'
]);

// Without this, iOS issues no PushKit token and the failure is silent from the
// server: APNs keeps accepting pushes and reporting them delivered.
check(IOS_ENTITLEMENTS, readFileSync(join(example, IOS_ENTITLEMENTS), 'utf8'), [
  'aps-environment'
]);

// Injecting twice would make Xcode compile the translation unit twice and fail
// on duplicate symbols, so the mod must be idempotent across repeat prebuilds.
{
  const pbxproj = readFileSync(join(example, IOS_PBXPROJ), 'utf8');
  const occurrences = pbxproj.split('SignalWireVoipPush.m in Sources').length - 1;
  if (occurrences !== 2) {
    failures.push(
      `${IOS_PBXPROJ}: expected exactly 2 references to "SignalWireVoipPush.m in Sources" ` +
        `(one PBXBuildFile, one in the Sources phase), found ${occurrences}`
    );
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} plugin assertion(s) failed:`);
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}

console.log(
  `\n✓ ${EXPECTED_ANDROID_PERMISSIONS.length} Android permissions, ` +
    `${EXPECTED_PLIST_ENTRIES.length} iOS Info.plist entries, and the VoIP push ` +
    `hook (generated and compiled) applied by the plugin.`
);
