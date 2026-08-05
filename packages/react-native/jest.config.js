module.exports = {
  preset: 'react-native',
  setupFilesAfterEnv: ['<rootDir>/jest/setup.ts'],
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|react-native-.*)/)'
  ],
  moduleNameMapper: {
    '^react-native-webrtc$': '<rootDir>/jest/mocks/react-native-webrtc.ts',
    '^react-native-callkeep$': '<rootDir>/jest/mocks/react-native-callkeep.ts',
    '^react-native-incall-manager$': '<rootDir>/jest/mocks/react-native-incall-manager.ts'
  }
};
