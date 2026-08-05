// Polyfills MUST come first — before @signalwire/js loads.
// They install crypto.getRandomValues (for the SDK's bundled uuid), a WHATWG
// URL that keeps custom schemes (the SDK parses `destination:<addr>`), and the
// CustomEvent/window stubs the SDK's entry point dispatches on at import time.
import '@signalwire/react-native/polyfills';

import { getCallKit } from '@signalwire/react-native/callkit';
import { registerRootComponent } from 'expo';

import App from './App';

// Set up native call UI before React mounts, so a VoIP push arriving on a cold
// start finds a bridge ready to report it to CallKit.
void getCallKit().setup({ appName: 'SignalWire RN Example', supportsVideo: true });

registerRootComponent(App);
