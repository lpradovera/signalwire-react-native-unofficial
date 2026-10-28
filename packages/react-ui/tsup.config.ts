import { readFileSync } from 'node:fs';

import { defineConfig } from 'tsup';

interface ComponentEntry {
  tag: string;
  className: string;
  name: string;
  events: Record<string, unknown>;
}

const COMPONENTS = JSON.parse(
  readFileSync(new URL('./scripts/components.json', import.meta.url), 'utf8')
) as ComponentEntry[];

/**
 * One entry per component, mirroring the `exports` map. Both are generated from
 * `scripts/components.json`, so they cannot drift apart.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    ...Object.fromEntries(
      COMPONENTS.map((c) => [`components/${c.name}`, `src/components/${c.name}.ts`])
    )
  },
  // ES modules only: see scripts/sync-package.mjs.
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'es2020',
  external: ['react', '@lit/react', '@signalwire/js', '@signalwire/web-components']
});
