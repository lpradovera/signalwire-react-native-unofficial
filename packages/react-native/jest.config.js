const path = require('path');

// React Native Firebase is an optional peer, installed by the example. Tests
// run the real package (see jest/rnfb.ts), so resolve it from there.
const RNFB_MESSAGING = require.resolve('@react-native-firebase/messaging', {
  paths: [path.resolve(__dirname, '../../example')]
});

module.exports = {
  preset: 'react-native',
  setupFilesAfterEnv: ['<rootDir>/jest/setup.ts'],
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
  // The react-native preset sets this to ['react-native'] only. `uuid` v14 has
  // no `main` and only ships CJS under its `node` condition, so without this
  // Jest resolves its ESM build and fails to parse it.
  testEnvironmentOptions: {
    customExportConditions: ['react-native', 'node', 'require', 'default']
  },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community|-firebase)?|react-native-.*|uuid)/)'
  ],
  moduleNameMapper: {
    // Resolve the core from source, so RN tests exercise current code rather
    // than a possibly-stale dist build.
    '^@signalwire/react$': '<rootDir>/../react/src/index.ts',
    // The SDK's ESM entry pulls in ESM-only `uuid`, which Jest cannot parse.
    // Its CJS bundle is self-contained and exposes the same surface.
    '^@signalwire/js$': '<rootDir>/../../node_modules/@signalwire/js/dist/index.cjs',
    '^@react-native-firebase/messaging$': RNFB_MESSAGING,
    '^react-native-webrtc$': '<rootDir>/jest/mocks/react-native-webrtc.ts',
    // The SignalWire callkeep fork, which the bridge prefers (callkit/callkeepModule).
    // Stock 'react-native-callkeep' is not mapped and not installed, so the
    // bridge's tests run on the fork's name; callkeepModule.test.ts mocks
    // each name itself to cover the stock fallback.
    '^@signalwire/react-native-callkeep$': '<rootDir>/jest/mocks/react-native-callkeep.ts',
    '^react-native-incall-manager$': '<rootDir>/jest/mocks/react-native-incall-manager.ts'
  }
};
