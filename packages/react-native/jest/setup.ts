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

// incall-manager's native module, linked (released, without iOS routes). The
// audio controller checks for it the way an app's build would have it.
{
  const { NativeModules } = require('react-native');
  NativeModules.InCallManager ??= { start: jest.fn() };
}
// react-native-webrtc's native module, as a linked build has it. The package
// checks for it before loading react-native-webrtc (platform/reactNativeWebRTC).
require('react-native').NativeModules.WebRTCModule ??= {};
