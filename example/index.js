// Polyfills MUST come first — before @signalwire/js loads.
// They install crypto.getRandomValues (for the SDK's bundled uuid), a WHATWG
// URL that keeps custom schemes (the SDK parses `destination:<addr>`), and the
// CustomEvent/window stubs the SDK's entry point dispatches on at import time.
import '@signalwire/react-native/polyfills';

import { setLogger, setLogLevel } from '@signalwire/js';
import { getCallKit } from '@signalwire/react-native/callkit';
import { registerRootComponent } from 'expo';

// TEMPORARY wire log. React Native's console collapses nested objects to
// `[Object]`, which hides the verto params and the SDP — exactly what you need
// when signalling succeeds but media never arrives. Stringify instead, and
// keep SDP on its own lines so candidate/m-line detail survives.
setLogLevel('trace');
setLogger({
  trace: (...a) => console.log('[sw:trace]', ...a.map(fmt)),
  debug: (...a) => console.log('[sw:debug]', ...a.map(fmt)),
  info: (...a) => console.log('[sw:info]', ...a.map(fmt)),
  warn: (...a) => console.warn('[sw:warn]', ...a.map(fmt)),
  error: (...a) => console.error('[sw:error]', ...a.map(fmt))
});

function fmt(value) {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 1);
  } catch {
    return String(value);
  }
}

import App from './App';

// Set up native call UI before React mounts, so a VoIP push arriving on a cold
// start finds a bridge ready to report it to CallKit.
void getCallKit().setup({ appName: 'SignalWire RN Example', supportsVideo: true });

registerRootComponent(App);
