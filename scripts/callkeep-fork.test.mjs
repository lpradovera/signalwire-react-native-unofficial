/**
 * callkeep is the SignalWire fork, @signalwire/react-native-callkeep (github
 * signalwire/react-native-callkeep, tag v4.4.0), pinned to one commit until
 * it is on npm, instead of npm's react-native-callkeep 4.3.16 plus a
 * patch-package patch.
 *
 * Stock 4.3.16 exports two @ReactMethods named displayIncomingCall (and
 * startCall), which the New Architecture refuses at launch; its onHostDestroy
 * kills the process before the endCall it sends reaches JavaScript (Back
 * mid-call left the call up on SignalWire). The fork fixes both and adds
 * didFailCallAction and the Telecom route details the package uses.
 *
 * Apps may still use stock react-native-callkeep: the package resolves either
 * (src/callkit/callkeepModule.ts), so both are optional peers.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const json = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const FORK_NAME = '@signalwire/react-native-callkeep';
const STOCK_NAME = 'react-native-callkeep';
const FORK = /^github:signalwire\/react-native-callkeep#([0-9a-f]{40})$/;
const pkgJson = () => json('packages/react-native/package.json');

test('the example and the package pin the same fork commit', () => {
  const example = json('example/package.json').dependencies[FORK_NAME];
  const pkg = pkgJson().devDependencies[FORK_NAME];
  assert.match(example, FORK);
  assert.equal(pkg, example);
});

test('neither installs stock react-native-callkeep', () => {
  assert.equal(json('example/package.json').dependencies[STOCK_NAME], undefined);
  assert.equal(pkgJson().devDependencies[STOCK_NAME], undefined);
});

test('the lockfile resolves the fork to that commit', () => {
  const sha = json('example/package.json').dependencies[FORK_NAME].match(FORK)[1];
  const locked = json('package-lock.json').packages[`node_modules/${FORK_NAME}`];
  assert.ok(locked, `${FORK_NAME} is in the lockfile`);
  assert.match(locked.resolved, new RegExp(`github\\.com/signalwire/react-native-callkeep\\.git#${sha}$`));
  assert.equal(json('package-lock.json').packages[`node_modules/${STOCK_NAME}`], undefined);
});

test("the installed callkeep is the fork's", () => {
  const dir = join(root, 'node_modules', FORK_NAME);
  assert.equal(json(`node_modules/${FORK_NAME}/package.json`).name, FORK_NAME);
  assert.match(readFileSync(join(dir, 'actions.js'), 'utf8'), /didFailCallAction/);
  const module = readFileSync(
    join(dir, 'android/src/main/java/io/wazo/callkeep/RNCallKeepModule.java'),
    'utf8'
  );
  assert.doesNotMatch(module, /killProcess/);
});

test('both callkeeps are optional peers, and the ranges accept the fork and stock 4.3.16', async () => {
  const { default: semver } = await import('semver');
  const { peerDependencies, peerDependenciesMeta } = pkgJson();
  const installed = json(`node_modules/${FORK_NAME}/package.json`).version;
  assert.ok(semver.satisfies(installed, peerDependencies[FORK_NAME]), `${installed} satisfies ${peerDependencies[FORK_NAME]}`);
  assert.ok(semver.satisfies('4.3.16', peerDependencies[STOCK_NAME]), `stock 4.3.16 satisfies ${peerDependencies[STOCK_NAME]}`);
  assert.equal(peerDependenciesMeta[FORK_NAME]?.optional, true);
  assert.equal(peerDependenciesMeta[STOCK_NAME]?.optional, true);
});

test('only callkeepModule and the config plugin name a callkeep package in source', () => {
  // Everything else goes through callkit/callkeepModule.ts, so an app with
  // either package works. Tests use the fork's name (jest.config.js maps it).
  const src = join(root, 'packages/react-native/src');
  const allowed = new Set(['callkit/callkeepModule.ts', 'callkit/callkeepModule.test.ts', 'plugin/callKeep.ts', 'plugin/callKeep.test.ts']);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
        const name = relative(src, path);
        const code = readFileSync(path, 'utf8');
        if (!allowed.has(name) && /(from|require\()\s*['"](@signalwire\/)?react-native-callkeep['"]/.test(code)) {
          offenders.push(name);
        }
      }
    }
  };
  walk(src);
  assert.deepEqual(offenders, []);
});

test('no patch-package patch is left for callkeep', () => {
  const root_ = json('package.json');
  assert.equal(root_['//patches'], undefined);
  // patch-package runs for the @signalwire/js hold patch; none patches callkeep.
  const patches = existsSync(join(root, 'patches')) ? readdirSync(join(root, 'patches')) : [];
  assert.deepEqual(patches.filter((name) => name.includes('callkeep')), []);
});
