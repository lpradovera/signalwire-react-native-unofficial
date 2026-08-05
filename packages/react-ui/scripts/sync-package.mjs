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

const entry = (name) => ({
  import: { types: `./dist/${name}.d.mts`, default: `./dist/${name}.mjs` },
  require: { types: `./dist/${name}.d.ts`, default: `./dist/${name}.js` }
});

pkg.exports = {
  '.': entry('index'),
  // Re-exported so apps can `import '@signalwire/react-ui/theme.css'` without
  // reaching into the Lit package's internals.
  './theme.css': './theme.css',
  ...Object.fromEntries(
    COMPONENTS.map((c) => [`./${subpath(c.tag)}`, entry(`components/${c.name}`)])
  )
};

// NOT false. Every component module calls customElements.define at import
// time; marking the package side-effect-free lets bundlers drop that
// registration and the element silently never upgrades.
pkg.sideEffects = true;

await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
console.log(`Synced ${COMPONENTS.length + 1} export entries.`);
