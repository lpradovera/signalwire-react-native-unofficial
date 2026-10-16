/**
 * Checks that patches/react-native-callkeep+<version>.patch is applied to the
 * react-native-callkeep the example installs.
 *
 * callkeep 4.3.16 exports displayIncomingCall and startCall twice on Android
 * (3- and 4-argument @ReactMethod overloads). React Native's New Architecture
 * interop refuses a module with two methods of one name, and the app dies at
 * the first NativeModules.RNCallKeep access ("Unable to parse @ReactMethod
 * annotations"). The patch removes the 3-argument overloads, as upstream did
 * in a6573f1b; the root postinstall (patch-package) applies it.
 *
 * Usage: node --test scripts/callkeep-patch.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromExample = createRequire(join(root, 'example', 'package.json'));
const callkeepDir = dirname(requireFromExample.resolve('react-native-callkeep/package.json'));
const callkeepVersion = JSON.parse(readFileSync(join(callkeepDir, 'package.json'), 'utf8')).version;
const moduleJava = join(
  callkeepDir,
  'android/src/main/java/io/wazo/callkeep/RNCallKeepModule.java'
);

/** Names of the methods marked @ReactMethod, in source order. */
function reactMethodNames(source) {
  const names = [];
  const re = /@ReactMethod(?:\([^)]*\))?\s+(?:public\s+)?(?:static\s+)?[\w<>[\],\s]+?\s+(\w+)\s*\(/g;
  for (const match of source.matchAll(re)) names.push(match[1]);
  return names;
}

test('reactMethodNames finds overloads', () => {
  const source = `
    @ReactMethod
    public void startCall(String a) {}
    @ReactMethod(isBlockingSynchronousMethod = true)
    public boolean isOn() { return true; }
    @ReactMethod
    public void startCall(String a, boolean b) {}`;
  assert.deepEqual(reactMethodNames(source), ['startCall', 'isOn', 'startCall']);
});

test('the callkeep patch matches the installed callkeep version', () => {
  const patches = readdirSync(join(root, 'patches')).filter((f) =>
    f.startsWith('react-native-callkeep+')
  );
  assert.deepEqual(
    patches,
    [`react-native-callkeep+${callkeepVersion}.patch`],
    `react-native-callkeep is ${callkeepVersion}. If that release contains upstream ` +
      'a6573f1b (no duplicate @ReactMethod names), delete the patch and this test; ' +
      'otherwise regenerate the patch for it with `npx patch-package react-native-callkeep`.'
  );
});

test('RNCallKeepModule exports each @ReactMethod name once (New Architecture)', () => {
  const names = reactMethodNames(readFileSync(moduleJava, 'utf8'));
  assert.ok(names.includes('displayIncomingCall') && names.includes('startCall'), names.join());
  const duplicates = names.filter((name, i) => names.indexOf(name) !== i);
  assert.deepEqual(
    duplicates,
    [],
    `${moduleJava} exports ${duplicates.join(', ')} more than once; ` +
      'run `npm install` so postinstall (patch-package) applies patches/.'
  );
});
