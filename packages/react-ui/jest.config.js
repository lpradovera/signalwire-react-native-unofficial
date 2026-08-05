module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
  transform: {
    // allowJs so the ESM-only @lit/react is transpiled to CJS for Jest.
    '^.+\\.[jt]sx?$': ['ts-jest', { tsconfig: { jsx: 'react-jsx', allowJs: true } }]
  },
  transformIgnorePatterns: ['node_modules/(?!(@lit/react)/)'],
  moduleNameMapper: {
    // See jest/web-components.mock.js for why the real Lit elements are not loaded.
    '^@signalwire/web-components/.*$': '<rootDir>/jest/web-components.mock.js'
  }
};
