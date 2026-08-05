module.exports = {
  preset: 'react-native',
  setupFilesAfterEnv: ['<rootDir>/jest/setup.ts'],
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
  testEnvironmentOptions: {
    customExportConditions: ['react-native', 'node', 'require', 'default']
  },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|react-native-.*|uuid)/)'
  ],
  moduleNameMapper: {
    '^@signalwire/js$': '<rootDir>/../../node_modules/@signalwire/js/dist/index.cjs',
    '^@signalwire/react$': '<rootDir>/../react/src/index.ts',
    '^@signalwire/react-native$': '<rootDir>/../react-native/src/index.ts'
  }
};
