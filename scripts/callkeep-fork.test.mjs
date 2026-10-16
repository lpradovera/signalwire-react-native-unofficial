/**
 * react-native-callkeep comes from the SignalWire fork (github
 * mjerris/react-native-callkeep, branch signalwire/main), pinned to one
 * commit, instead of npm's 4.3.16 plus a patch-package patch.
 *
 * Stock 4.3.16 exports two @ReactMethods named displayIncomingCall (and
 * startCall), which the New Architecture refuses at launch; its onHostDestroy
 * kills the process before the endCall it sends reaches JavaScript (Back
 * mid-call left the call up on SignalWire). The fork fixes both and adds
 * didFailCallAction and the Telecom route details the package uses.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const json = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const FORK = /^github:mjerris\/react-native-callkeep#([0-9a-f]{40})$/;

test('the example and the package pin the same fork commit', () => {
  const example = json('example/package.json').dependencies['react-native-callkeep'];
  const pkg = json('packages/react-native/package.json').devDependencies['react-native-callkeep'];
  assert.match(example, FORK);
  assert.equal(pkg, example);
});

test('the lockfile resolves callkeep to that commit of the fork', () => {
  const sha = json('example/package.json').dependencies['react-native-callkeep'].match(FORK)[1];
  const locked = json('package-lock.json').packages['node_modules/react-native-callkeep'];
  assert.ok(locked, 'react-native-callkeep is in the lockfile');
  assert.match(locked.resolved, new RegExp(`github\\.com/mjerris/react-native-callkeep\\.git#${sha}$`));
  assert.match(locked.version, /-signalwire\./);
});

test("the installed callkeep is the fork's", () => {
  const installed = json('node_modules/react-native-callkeep/package.json');
  assert.match(installed.version, /-signalwire\./);
  const actions = readFileSync(join(root, 'node_modules/react-native-callkeep/actions.js'), 'utf8');
  assert.match(actions, /didFailCallAction/);
  const module = readFileSync(
    join(root, 'node_modules/react-native-callkeep/android/src/main/java/io/wazo/callkeep/RNCallKeepModule.java'),
    'utf8'
  );
  assert.doesNotMatch(module, /killProcess/);
});

test("the peer range accepts the fork's prerelease version", async () => {
  const { default: semver } = await import('semver');
  const range = json('packages/react-native/package.json').peerDependencies['react-native-callkeep'];
  const installed = json('node_modules/react-native-callkeep/package.json').version;
  assert.ok(semver.satisfies(installed, range), `${installed} satisfies ${range}`);
  assert.ok(semver.satisfies('4.3.16', range), `stock 4.3.16 still satisfies ${range}`);
});

test('no patch-package patch is left for callkeep', () => {
  const root_ = json('package.json');
  assert.equal(root_.scripts.postinstall, undefined);
  assert.equal(root_['//patches'], undefined);
});
