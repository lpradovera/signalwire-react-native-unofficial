// The Android microphone foreground service for calls outside Telecom
// (packages/react-native/android/…/CallForegroundService.java). The library
// manifest merges into every app that links the package, bare or Expo, so the
// service and what it needs are declared there. The emulator check
// (docs/device-testing.md) shows it running; these pin the declarations that
// Android 14+ refuses the start without.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = join(root, 'packages/react-native/android/src/main');
const manifest = readFileSync(join(main, 'AndroidManifest.xml'), 'utf8');
const java = (name) => readFileSync(join(main, 'java/com/signalwire/reactnative', name), 'utf8');

function serviceTag(name) {
  const tag = manifest.match(/<service\b[^>]*>/gs)?.find((t) => t.includes(`android:name="${name}"`));
  assert.ok(tag, `no <service> for ${name}`);
  return tag;
}

test('the service is declared with the microphone type only, not exported', () => {
  const tag = serviceTag('com.signalwire.reactnative.CallForegroundService');
  // phoneCall needs MANAGE_OWN_CALLS (a Telecom call) and camera a CAMERA
  // grant; Android 14+ refuses a start with a type it may not use.
  assert.match(tag, /android:foregroundServiceType="microphone"/);
  assert.match(tag, /android:exported="false"/);
});

test('the permissions a microphone foreground service needs are declared', () => {
  for (const permission of ['FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_MICROPHONE']) {
    assert.ok(
      manifest.includes(`<uses-permission android:name="android.permission.${permission}" />`),
      permission
    );
  }
});

test('it goes to the foreground with an explicit microphone type', () => {
  const source = java('CallForegroundService.java');
  assert.match(source, /ServiceCompat\.startForeground\(/);
  assert.ok(source.includes('ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE'));
  // A plain startService(): startForegroundService() crashes the app when the
  // service then cannot call startForeground() (no grant, or in the background).
  assert.ok(!java('CallForegroundServiceModule.java').includes('startForegroundService('));
});

test('the module is registered with the package', () => {
  assert.ok(java('SignalWireReactNativePackage.java').includes('new CallForegroundServiceModule(context)'));
});
