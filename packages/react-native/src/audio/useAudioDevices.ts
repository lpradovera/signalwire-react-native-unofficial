import { useObservable } from '@signalwire/react';
import { NO_AUDIO_DEVICES, audioDevices$ } from './nativeAudioRoutes';

import type { AudioDeviceStatus } from './nativeAudioRoutes';

/**
 * What the phone can play a call through and what it is playing through now,
 * by device (`WIRED_HEADSET`, or the car's own name). During a call it is
 * kept current as headsets and cars come and go; incall-manager reports
 * changes only while a call's session runs, so outside a call it holds the
 * last status read, which for the app's own session usually lists only the
 * receiver, the speaker and the current media output. `useAudioRoute().route`
 * is the coarser route, one of four (`'earpiece' | 'speaker' | 'headset' |
 * 'bluetooth'`, a wired or USB-C headset being `'headset'`), that the speaker
 * toggle works with; with iOS routes it follows the same reports.
 *
 * iOS only, and only with a react-native-incall-manager that has iOS audio
 * routes (see "Audio routes on iOS" in the README). Otherwise it stays empty:
 * `available: []`, `selected: null`.
 */
export function useAudioDevices(): AudioDeviceStatus {
  return useObservable(audioDevices$, NO_AUDIO_DEVICES);
}
