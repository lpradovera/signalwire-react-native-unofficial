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
    stdio: 'pipe'
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

if (failures.length > 0) {
  console.error(`\n${failures.length} plugin assertion(s) failed:`);
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}

console.log(
  `\n✓ ${EXPECTED_ANDROID_PERMISSIONS.length} Android permissions and ` +
    `${EXPECTED_PLIST_ENTRIES.length} iOS Info.plist entries applied by the plugin.`
);
