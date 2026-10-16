import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface ComponentEntry {
  tag: string;
  className: string;
  name: string;
  events: Record<string, string | { event: string; from: string }>;
}

const root = join(__dirname, '..');
const COMPONENTS = JSON.parse(
  readFileSync(join(root, 'scripts', 'components.json'), 'utf8')
) as ComponentEntry[];
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  exports: Record<string, unknown>;
  sideEffects: unknown;
};

/**
 * The manifest drives the generated wrappers, the `exports` map and the tsup
 * entries. If those fall out of step the failure lands in a consumer's project
 * as an unresolvable import, which is the worst place to discover it.
 */
describe('component manifest', () => {
  it('wraps only SDK-aware components, not sw-ui-* primitives', () => {
    const primitives = COMPONENTS.filter((c) => c.tag.startsWith('sw-ui-'));
    expect(primitives).toEqual([]);
  });

  it('has a generated wrapper file for every entry', () => {
    for (const component of COMPONENTS) {
      const file = join(root, 'src', 'components', `${component.name}.ts`);
      expect(existsSync(file)).toBe(true);
    }
  });

  it('has a package export for every entry', () => {
    for (const component of COMPONENTS) {
      const subpath = `./${component.tag.replace(/^sw-/, '')}`;
      expect(pkg.exports).toHaveProperty([subpath]);
    }
  });

  it('exports no subpath without a manifest entry', () => {
    const known = new Set([
      '.',
      './theme.css',
      ...COMPONENTS.map((c) => `./${c.tag.replace(/^sw-/, '')}`)
    ]);
    for (const subpath of Object.keys(pkg.exports)) {
      expect(known.has(subpath)).toBe(true);
    }
  });

  it('is NOT marked side-effect free', () => {
    // Every component module calls customElements.define at import time.
    // `sideEffects: false` would let bundlers drop that registration, and the
    // element would silently never upgrade.
    expect(pkg.sideEffects).toBe(true);
  });

  it('ships theme.css alongside the package', () => {
    expect(existsSync(join(root, 'theme.css'))).toBe(true);
  });

  it('maps every event name to an on* prop', () => {
    // Which names the elements really fire is checked against the installed
    // package in test/entries.test.mjs.
    for (const component of COMPONENTS) {
      for (const [prop, spec] of Object.entries(component.events)) {
        expect(prop).toMatch(/^on[A-Z]/);
        const domEvent = typeof spec === 'string' ? spec : spec.event;
        expect(domEvent).toMatch(/^(sw|signalwire)-[a-z-]+(:[a-z-]+)?$/);
        if (typeof spec !== 'string') {
          expect(spec.from).toMatch(/^sw-[a-z-]+$/);
        }
      }
    }
  });

  it('marks every generated component and the barrel as a client module', () => {
    const files = [
      join(root, 'src', 'index.ts'),
      ...COMPONENTS.map((c) => join(root, 'src', 'components', `${c.name}.ts`))
    ];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      // Lit elements touch the DOM at module scope, so these can never run in
      // a React Server Component.
      expect(source).toContain("'use client'");
    }
  });
});
