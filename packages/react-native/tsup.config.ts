import { defineConfig } from 'tsup';

import type { Options } from 'tsup';

type Plugin = NonNullable<Options['plugins']>[number];

/**
 * Keeps an optional `require('peer')` a plain `require` in the ES-module build.
 *
 * esbuild has no `require` in ESM output, so it rewrites one into its own
 * `__require("peer")` shim. Metro collects dependencies from literal
 * `require`/`import` calls only, so the peer was never bundled, and the shim,
 * bound to Metro's require at runtime, threw "Requiring unknown module". Every
 * app that `import`s `@signalwire/react-native/callkit` resolves to the `.mjs`,
 * so Android call push was off for all of them, and an app whose push effect
 * ran died in a release build (Firebase messaging is the optional peer,
 * required inside a try; see `push/firebaseMessaging.ts`).
 *
 * Under Metro every module, ESM included, runs inside a function that is
 * handed `require`, so a plain call is both what Metro bundles and what works.
 * The replacement is padded to the same length so the source map stays exact.
 * `scripts/check-metro-deps.mjs` proves the result after every build.
 */
const keepLazyRequires: Plugin = {
  name: 'keep-lazy-requires',
  renderChunk(code, info) {
    if (this.format !== 'esm') {
      return undefined;
    }
    return {
      code: code.replace(/\b__require\((\s*["'])/g, '  require($1'),
      map: info.map
    };
  }
};

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    callkit: 'src/callkit.ts',
    ringing: 'src/ringing.ts',
    audio: 'src/audio.ts',
    polyfills: 'src/polyfills.ts',
    'plugin/withSignalWire': 'src/plugin/withSignalWire.ts'
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'es2020',
  plugins: [keepLazyRequires],
  external: [
    '@signalwire/js',
    'rxjs',
    'react',
    'react-native',
    'react-native-webrtc',
    'react-native-callkeep',
    'react-native-incall-manager',
    '@react-native-async-storage/async-storage',
    '@react-native-community/netinfo',
    '@react-native-firebase/messaging',
    '@expo/config-plugins'
  ]
});
