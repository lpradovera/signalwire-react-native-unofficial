/**
 * Audio routing for React Native.
 *
 * Requires the optional peer `react-native-incall-manager`. On iOS, routes
 * other than speaker on/off and the device status need an incall-manager with
 * iOS audio routes; see "Audio routes on iOS" in the README. The route picker
 * button is this package's own native view, which an app gets by rebuilding
 * (pod install).
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
export { getAudioDeviceStatus } from './audio/nativeAudioRoutes';
export type { AudioDeviceName, AudioDeviceStatus } from './audio/nativeAudioRoutes';
export { AudioRoutePickerButton, isAudioRoutePickerAvailable } from './audio/AudioRoutePickerButton';
export type { AudioRoutePickerButtonProps } from './audio/AudioRoutePickerButton';
