#!/usr/bin/env node
/**
 * Keeps package.json `exports` and tsup entries in step with the manifest.
 *
 * Generating both from one list is the point: a per-component subpath that
 * exists in tsup but not in `exports` (or vice versa) fails only in a
 * consumer's project, which is the worst place to find out.
 */
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMPONENTS = JSON.parse(
  readFileSync(new URL('./components.json', import.meta.url), 'utf8')
);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));

const subpath = (tag) => tag.replace(/^sw-/, '');

// ES modules only. @signalwire/web-components is `type: module` and its
// subpaths define only the `import` condition, so a CommonJS build of these
// wrappers could never require() them (ERR_PACKAGE_PATH_NOT_EXPORTED). `default`
// rather than `import` lets a require() on a Node that loads ES modules
// through require() (20.19+, 22.12+) reach the same files.
const entry = (name) => ({ types: `./dist/${name}.d.mts`, default: `./dist/${name}.mjs` });

pkg.main = './dist/index.mjs';
pkg.types = './dist/index.d.mts';
delete pkg.module;

pkg.exports = {
  '.': entry('index'),
  // A copy of @signalwire/web-components' public './theme.css' export, kept
  // identical by test/entries.test.mjs.
  './theme.css': './theme.css',
  ...Object.fromEntries(
    COMPONENTS.map((c) => [`./${subpath(c.tag)}`, entry(`components/${c.name}`)])
  )
};

// TypeScript's node10 ("node") resolution ignores `exports`, so without this a
// subpath import there finds no types (TS2307) although they ship.
pkg.typesVersions = {
  '*': Object.fromEntries(
    COMPONENTS.map((c) => [subpath(c.tag), [`./dist/components/${c.name}.d.mts`]])
  )
};

// NOT false. Every component module calls customElements.define at import
// time; marking the package side-effect-free lets bundlers drop that
// registration and the element silently never upgrades.
pkg.sideEffects = true;

await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
console.log(`Synced ${COMPONENTS.length + 1} export entries.`);
