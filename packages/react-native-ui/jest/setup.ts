// The SDK's entry point dispatches a CustomEvent on `window` at import time,
// which throws in a React Native runtime without these. Mirrors what
// `@signalwire/react-native/polyfills` does in a real app.
const { installBaseGlobals } = require('../../react-native/src/platform/baseGlobals');
installBaseGlobals();
