/**
 * React Native support for `@signalwire/js`.
 *
 * Import `@signalwire/react-native/polyfills` first, from your app entry file.
 */

// Platform
export { createReactNativePlatform } from './platform/createReactNativePlatform';
export type {
  ReactNativePlatform,
  ReactNativePlatformOptions
} from './platform/createReactNativePlatform';
export { createWebRTCApiProvider } from './platform/webrtc';
export { ReactNativeStorage } from './platform/storage';
export type { AsyncStorageLike, StorageScope } from './platform/storage';
export { installBaseGlobals } from './platform/baseGlobals';

// React
export { SignalWireProvider, SignalWireContext } from './react/SignalWireProvider';
export type { SignalWireContextValue, SignalWireProviderProps } from './react/SignalWireProvider';
export { useSignalWire } from './react/useSignalWire';
export type { UseSignalWireResult } from './react/useSignalWire';
export { useCall } from './react/useCall';
export type { UseCallResult } from './react/useCall';
export { useIncomingCalls } from './react/useIncomingCalls';
export type { UseIncomingCallsResult } from './react/useIncomingCalls';
export { useDevices } from './react/useDevices';
export type { UseDevicesResult } from './react/useDevices';
export { useObservable } from './react/useObservable';

// Components
export { SignalWireVideoView } from './components/SignalWireVideoView';
export type { SignalWireVideoViewProps } from './components/SignalWireVideoView';

// Errors
export { MissingPeerDependencyError, PolyfillNotInstalledError } from './errors';
