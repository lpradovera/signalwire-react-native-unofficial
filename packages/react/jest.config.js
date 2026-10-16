/**
 * jsdom, not the react-native preset — on purpose. If a test in this package
 * ever needs the RN preset, the universal boundary has leaked.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
  transform: {
    // allowJs so the ESM-only uuid the real SDK requires is transpiled to CJS
    // for the tests that load the real SDK (jest/realSdk.ts).
    '^.+\\.[jt]sx?$': ['ts-jest', { tsconfig: { jsx: 'react-jsx', allowJs: true } }]
  },
  transformIgnorePatterns: ['node_modules/(?!(uuid)/)'],
  moduleNameMapper: {
    // Hermetic double — see jest/signalwire-js.mock.ts for why.
    '^@signalwire/js$': '<rootDir>/jest/signalwire-js.mock.ts'
  }
};
