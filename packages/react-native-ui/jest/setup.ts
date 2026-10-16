// The SDK's entry point dispatches a CustomEvent on `window` at import time,
// which throws in a React Native runtime without these. Mirrors what
// `@signalwire/react-native/polyfills` does in a real app.
const { installBaseGlobals } = require('../../react-native/src/platform/baseGlobals');
installBaseGlobals();

// The native SafeAreaProvider renders nothing until it measures a frame, which
// never happens under Jest; the library's own mock reports zero insets.
jest.mock('react-native-safe-area-context', () =>
  jest.requireActual('react-native-safe-area-context/jest/mock').default
);
