#!/usr/bin/env node
/**
 * Checks the built packages the way Metro will read them.
 *
 * Metro bundles a module only if its dependency collector sees a literal
 * `import` or `require('name')` for it. esbuild compiles a `require` inside an
 * ES-module build into its own `__require("name")` shim, which Metro does not
 * collect: the package is left out of the bundle and the shim, bound to
 * Metro's require, throws "Requiring unknown module" at runtime. That is how
 * Android call push was silently off for every app that `import`s
 * `@signalwire/react-native/callkit` (dist/callkit.mjs): Firebase was never
 * bundled.
 *
 * Run after `npm run build`. For every entry built as both `.js` and `.mjs` it
 * asserts that
 *   1. no `__require(` call is left in either file, and
 *   2. Metro collects the same dependencies from both, so an app gets the same
 *      bundle whether it imports or requires the entry, and
 *   3. the lazy peers this package loads at runtime are among them, and Metro
 *      treats each as optional (a `require` inside a try), so an app that
 *      installed only one callkeep, or no Firebase, still bundles.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const parser = require('@babel/parser');
const collectDependencies = require('metro/private/ModuleGraph/worker/collectDependencies').default;

/**
 * callkeep under either name: the SignalWire fork first, else stock
 * (`callkit/callkeepModule.ts`). Each is an optional `require` in a try, so
 * both must reach Metro; the one an app did not install is dropped from its
 * bundle as an optional dependency.
 */
const CALLKEEP = ['@signalwire/react-native-callkeep', 'react-native-callkeep'];

/** Peers each entry requires lazily, and so must reach Metro as dependencies. */
const LAZY_PEERS = {
  'packages/react-native/dist/callkit': ['@react-native-firebase/messaging', ...CALLKEEP],
  'packages/react-native/dist/index': CALLKEEP
};

const DIST_DIRS = [
  'packages/react/dist',
  'packages/react-ui/dist',
  'packages/react-native/dist',
  'packages/react-native-ui/dist'
];

/** Metro's dependencies of `file`: name -> whether it is optional. */
function metroDependencies(file) {
  const code = fs.readFileSync(file, 'utf8');
  const ast = parser.parse(code, { sourceType: 'unambiguous', plugins: ['jsx'] });
  const { dependencies } = collectDependencies(ast, {
    asyncRequireModulePath: 'metro-runtime/src/modules/asyncRequire',
    dynamicRequires: 'throwAtRuntime',
    inlineableCalls: [],
    keepRequireNames: true,
    allowOptionalDependencies: true,
    dependencyMapName: null,
    unstable_allowRequireContext: false,
    unstable_isESMImportAtSource: null
  });
  return new Map(dependencies.map((dependency) => [dependency.name, dependency.data.isOptional === true]));
}

const failures = [];
let checked = 0;

for (const dir of DIST_DIRS) {
  const absolute = path.join(root, dir);
  if (!fs.existsSync(absolute)) {
    failures.push(`${dir} does not exist; run \`npm run build\` first`);
    continue;
  }
  const entries = fs
    .readdirSync(absolute)
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => name.slice(0, -'.mjs'.length))
    .filter((base) => fs.existsSync(path.join(absolute, `${base}.js`)));

  for (const base of entries) {
    const key = `${dir}/${base}`;
    const esm = path.join(absolute, `${base}.mjs`);
    const cjs = path.join(absolute, `${base}.js`);

    for (const file of [esm, cjs]) {
      const calls = fs.readFileSync(file, 'utf8').match(/__require\(\s*["'][^"']+["']\s*\)/g) ?? [];
      if (calls.length > 0) {
        failures.push(
          `${path.relative(root, file)}: esbuild require shim Metro cannot follow: ${calls.join(', ')}`
        );
      }
    }

    const esmDeps = metroDependencies(esm);
    const cjsDeps = metroDependencies(cjs);
    const onlyCjs = [...cjsDeps.keys()].filter((name) => !esmDeps.has(name));
    const onlyEsm = [...esmDeps.keys()].filter((name) => !cjsDeps.has(name));
    if (onlyCjs.length > 0) {
      failures.push(`${key}.mjs: Metro does not see ${onlyCjs.join(', ')} (the .js build does)`);
    }
    if (onlyEsm.length > 0) {
      failures.push(`${key}.js: Metro does not see ${onlyEsm.join(', ')} (the .mjs build does)`);
    }
    for (const peer of LAZY_PEERS[key] ?? []) {
      for (const [file, deps] of [
        [esm, esmDeps],
        [cjs, cjsDeps]
      ]) {
        if (!deps.has(peer)) {
          failures.push(
            `${path.relative(root, file)}: ${peer} is not a dependency Metro will bundle`
          );
        } else if (!deps.get(peer)) {
          failures.push(
            `${path.relative(root, file)}: ${peer} is not optional to Metro (not required inside a try), ` +
              'so an app without it fails to bundle'
          );
        }
      }
    }
    checked += 1;
  }
}

if (failures.length > 0) {
  console.error('check-metro-deps: FAILED');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}
console.log(
  `check-metro-deps: ${checked} entries, ESM and CJS builds give Metro the same dependencies`
);
