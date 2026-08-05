// Mirrors what `@signalwire/react-native/polyfills` does in a real app: the SDK
// entry point dispatches a CustomEvent on `window` at import time, which throws
// in a React Native runtime without these.
const { installBaseGlobals } = require('../src/platform/baseGlobals');
installBaseGlobals();

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('@react-native-community/netinfo', () => ({
  addEventListener: jest.fn(() => jest.fn()),
  fetch: jest.fn(() => Promise.resolve({ isConnected: true, isInternetReachable: true }))
}));
