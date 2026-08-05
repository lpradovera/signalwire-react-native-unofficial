import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'es2020',
  external: ['react', 'react-native', '@signalwire/js', '@signalwire/react', '@signalwire/react-native']
});
