// Polyfills MUST come first — before @signalwire/js loads.
// They install crypto.getRandomValues (for the SDK's bundled uuid), a WHATWG
// URL that keeps custom schemes (the SDK parses `destination:<addr>`), and the
// CustomEvent/window stubs the SDK's entry point dispatches on at import time.
import '@signalwire/react-native/polyfills';

import { setDebugOptions, setLogger, setLogLevel } from '@signalwire/js';
import { getCallKit } from '@signalwire/react-native/callkit';
import { registerRootComponent } from 'expo';

// Wire log, off by default. React Native's console collapses nested objects to
// `[Object]`, which hides the verto params and the SDP — exactly what you need
// when signalling succeeds but media never arrives. Set EXPO_PUBLIC_SW_WIRE_LOG=1
// to stringify everything and log each WebSocket frame.
if (process.env.EXPO_PUBLIC_SW_WIRE_LOG === '1') {
  const fmt = (value) => {
    if (typeof value === 'string') {
      return value;
    }
    try {
      return JSON.stringify(value, null, 1);
    } catch {
      return String(value);
    }
  };
  setLogLevel('trace');
  // WS frames carry the verto invite and its SDP; the SDK logs neither at any
  // ordinary level. The custom logger must supply wsTraffic or they are dropped.
  setDebugOptions({ logWsTraffic: true });
  setLogger({
    wsTraffic: (o) => console.log('[sw:ws]', o?.type, o?.raw ?? fmt(o?.payload)),
    trace: (...a) => console.log('[sw:trace]', ...a.map(fmt)),
    debug: (...a) => console.log('[sw:debug]', ...a.map(fmt)),
    info: (...a) => console.log('[sw:info]', ...a.map(fmt)),
    warn: (...a) => console.warn('[sw:warn]', ...a.map(fmt)),
    error: (...a) => console.error('[sw:error]', ...a.map(fmt))
  });
}

// Set up native call UI before React mounts, so a VoIP push arriving on a cold
// start finds a bridge ready to report it to CallKit.
void getCallKit().setup({ appName: 'SignalWire RN Example', supportsVideo: true });

registerRootComponent(App);
