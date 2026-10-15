/**
 * Audio routing for React Native.
 *
 * Requires the optional peer `react-native-incall-manager`. On iOS, routes other
 * than speaker on/off, the device status and the route picker button come from
 * this package's own native code, which an app gets by rebuilding (pod install).
 */
export {
  AudioRouteController,
  getAudioRouteController,
  resetAudioRouteControllerForTesting
} from './audio/AudioRouteController';
export type { AudioRoute } from './audio/AudioRouteController';
export { useAudioRoute } from './audio/useAudioRoute';
export type { UseAudioRouteResult } from './audio/useAudioRoute';
export { useAudioDevices } from './audio/useAudioDevices';
export {
  addAudioDeviceChangeListener,
  getAudioDeviceStatus,
  parseAudioDeviceStatus
} from './audio/nativeAudioRoutes';
export type { AudioDeviceName, AudioDeviceStatus } from './audio/nativeAudioRoutes';
export { AudioRoutePickerButton, isAudioRoutePickerAvailable } from './audio/AudioRoutePickerButton';
export type { AudioRoutePickerButtonProps } from './audio/AudioRoutePickerButton';
