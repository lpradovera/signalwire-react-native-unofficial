/**
 * jsdom, not the react-native preset — on purpose. If a test in this package
 * ever needs the RN preset, the universal boundary has leaked.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { jsx: 'react-jsx' } }]
  },
  moduleNameMapper: {
    // Hermetic double — see jest/signalwire-js.mock.ts for why.
    '^@signalwire/js$': '<rootDir>/jest/signalwire-js.mock.ts'
  }
};
