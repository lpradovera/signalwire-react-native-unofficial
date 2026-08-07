import { defineConfig } from 'tsup';

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
    '@expo/config-plugins'
  ]
});
