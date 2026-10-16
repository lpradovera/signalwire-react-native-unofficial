/**
 * Loads every published entry point of the BUILT package (dist/, through the
 * package's own `exports` map) against the REAL installed
 * @signalwire/web-components, the way a consumer's bundler or Node does.
 *
 * The jest suite maps @signalwire/web-components to a stub, so it cannot see
 * the upstream contract: a missing upstream file, a subpath that no longer
 * registers the elements it renders, or a broken require branch all passed it.
 * This file is where those fail.
 *
 * Node can evaluate the Lit elements without a DOM (lit's `node` export
 * condition installs a customElements shim), so each entry is imported in its
 * own child process, which gives it a fresh element registry.
 *
 * Needs `npm run build` first (the root `npm run verify` builds before testing).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const COMPONENTS = JSON.parse(readFileSync(join(root, 'scripts', 'components.json'), 'utf8'));

// The package root exports only `.`'s import condition (no ./package.json), so
// find dist/ from the barrel it resolves to.
const wcDist = dirname(fileURLToPath(import.meta.resolve('@signalwire/web-components')));
const wcComponents = join(wcDist, 'components');

assert.ok(
  existsSync(join(root, 'dist', 'index.mjs')),
  'dist/ is missing: run `npm run build -w @signalwire/react-ui` first'
);

/** Every `<tag>.js` module under upstream's dist/components, keyed by tag. */
function elementModules() {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/^sw-[a-z-]+\.js$/.test(entry.name)) {
        const tag = entry.name.slice(0, -3);
        // Lit's @customElement decorator, minified to `<alias>("sw-tag")`.
        const source = readFileSync(path, 'utf8');
        if (/\bcustomElement\b/.test(source) && source.includes(`("${tag}")`)) {
          out.set(tag, path);
        }
      }
    }
  };
  walk(wcComponents);
  return out;
}

const MODULES = elementModules();

/** Tags a module's templates render, following its relative imports. */
function renderedTags(file, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  const tags = new Set([...source.matchAll(/<(sw-[a-z-]+)/g)].map((m) => m[1]));
  for (const [, spec] of source.matchAll(/from "(\.[^"]+\.js)"/g)) {
    for (const tag of renderedTags(join(dirname(file), spec), seen)) tags.add(tag);
  }
  return tags;
}

/** The element and every element it can render, transitively. */
function closure(tag, out = new Set()) {
  if (out.has(tag)) return out;
  out.add(tag);
  const file = MODULES.get(tag);
  assert.ok(file, `no upstream module defines <${tag}>`);
  for (const child of renderedTags(file)) closure(child, out);
  return out;
}

/** Imports `spec` in a fresh Node process; returns the error or the registered tags. */
function load(spec, how = 'import') {
  const probe =
    how === 'import'
      ? `await import(${JSON.stringify(spec)});`
      : `(await import('node:module')).createRequire(process.cwd() + '/').call(null, ${JSON.stringify(spec)});`;
  const code = `
    try {
      ${probe}
      const tags = ${JSON.stringify([...MODULES.keys()])};
      console.log(JSON.stringify({ registered: tags.filter((t) => globalThis.customElements?.get(t)) }));
    } catch (error) {
      console.log(JSON.stringify({ error: String(error.code ?? '') + ' ' + String(error.message).split('\\n')[0] }));
    }`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root,
    encoding: 'utf8'
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const subpath = (tag) => `@signalwire/react-ui/${tag.replace(/^sw-/, '')}`;

test('the barrel loads and registers every wrapped element and everything they render', () => {
  const result = load('@signalwire/react-ui');
  assert.equal(result.error, undefined, `import '@signalwire/react-ui' failed: ${result.error}`);
  const needed = new Set(COMPONENTS.flatMap((c) => [...closure(c.tag)]));
  const missing = [...needed].filter((t) => !result.registered.includes(t));
  assert.deepEqual(missing, [], `the barrel leaves these unregistered: ${missing.join(', ')}`);
});

for (const component of COMPONENTS) {
  test(`${subpath(component.tag)} loads on its own and registers everything <${component.tag}> renders`, () => {
    const result = load(subpath(component.tag));
    assert.equal(result.error, undefined, `import '${subpath(component.tag)}' failed: ${result.error}`);
    const missing = [...closure(component.tag)].filter((t) => !result.registered.includes(t));
    assert.deepEqual(
      missing,
      [],
      `<${component.tag}> renders these, but importing ${subpath(component.tag)} alone leaves them unregistered: ${missing.join(', ')}`
    );
  });
}

test('every JavaScript entry in exports can also be loaded through require()', { skip: !process.features.require_module && 'this Node cannot require() ES modules' }, () => {
  const specs = Object.keys(pkg.exports)
    .filter((key) => !key.endsWith('.css'))
    .map((key) => (key === '.' ? '@signalwire/react-ui' : `@signalwire/react-ui/${key.slice(2)}`));
  const failures = specs
    .map((spec) => [spec, load(spec, 'require').error])
    .filter(([, error]) => error !== undefined);
  assert.deepEqual(failures, []);
});

test("every built JavaScript entry, the barrel included, starts with 'use client'", () => {
  const files = ['index.mjs', ...COMPONENTS.map((c) => `components/${c.name}.mjs`)];
  for (const file of files) {
    const source = readFileSync(join(root, 'dist', file), 'utf8');
    assert.match(source, /^(\/\/[^\n]*\n|\s)*['"]use client['"]/, `dist/${file} has no leading 'use client'`);
  }
});

test('TypeScript finds the types of every exports entry under node10, node16 and bundler resolution', async () => {
  const { default: ts } = await import('typescript');
  const consumer = join(root, 'test', 'consumer.ts');
  const modes = {
    node10: { moduleResolution: ts.ModuleResolutionKind.Node10, module: ts.ModuleKind.CommonJS },
    node16: { moduleResolution: ts.ModuleResolutionKind.Node16, module: ts.ModuleKind.Node16 },
    bundler: { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext }
  };
  const specs = Object.keys(pkg.exports)
    .filter((key) => !key.endsWith('.css'))
    .map((key) => (key === '.' ? '@signalwire/react-ui' : `@signalwire/react-ui/${key.slice(2)}`));
  const unresolved = [];
  for (const [mode, options] of Object.entries(modes)) {
    for (const spec of specs) {
      // node16 resolves as an ES module importer would; a CommonJS importer
      // cannot load this ESM-only package. The other modes take no importer kind.
      const kind = mode === 'node16' ? ts.ModuleKind.ESNext : undefined;
      const resolved = ts.resolveModuleName(spec, consumer, options, ts.sys, undefined, undefined, kind);
      if (!resolved.resolvedModule?.resolvedFileName.endsWith('.d.mts')) unresolved.push(`${mode}: ${spec}`);
    }
  }
  assert.deepEqual(unresolved, []);
});
