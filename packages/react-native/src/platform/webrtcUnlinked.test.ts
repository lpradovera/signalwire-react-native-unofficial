/**
 * react-native-webrtc installed but not linked (a dev client not rebuilt).
 *
 * The module throws while it is evaluated: on the New Architecture a missing
 * native module is `null`, and its `src/index.ts` throws "WebRTC native module
 * not found" (iOS fails a step earlier, in its EventEmitter's
 * `new NativeEventEmitter(null)`). Imported statically, that took down the
 * app's entry file before the package's own guard could run, and the guard
 * itself checked `mediaDevices.getUserMedia`, which the JS object always has.
 */
import { MissingPeerDependencyError } from '../errors';

jest.mock('react-native', () => ({ Platform: { OS: 'android' }, NativeModules: { WebRTCModule: null } }));
jest.mock('react-native-webrtc', () => {
  throw new Error('WebRTC native module not found.');
});

describe('react-native-webrtc installed but not linked', () => {
  it('importing the WebRTC provider and the video view does not evaluate react-native-webrtc', () => {
    expect(() => require('./webrtc')).not.toThrow();
    expect(() => require('../components/SignalWireVideoView')).not.toThrow();
  });

  it('createWebRTCApiProvider names the rebuild instead of crashing', () => {
    const { createWebRTCApiProvider } = require('./webrtc') as typeof import('./webrtc');
    expect(() => createWebRTCApiProvider()).toThrow(MissingPeerDependencyError);
  });
});
