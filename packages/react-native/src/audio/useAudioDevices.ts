import { useObservable } from '@signalwire/react';
import { NO_AUDIO_DEVICES, audioDevices$ } from './nativeAudioRoutes';

import type { AudioDeviceStatus } from './nativeAudioRoutes';

/**
 * What the phone can play a call through and what it is playing through now,
 * by device (`WIRED_HEADSET`, or the car's own name), kept current as
 * headsets and cars come and go. `useAudioRoute().route` is the coarser
 * three-way route (`'earpiece' | 'speaker' | 'bluetooth'`) the speaker toggle
 * works with; with iOS routes it follows the same reports.
 *
 * iOS only, and only with a react-native-incall-manager that has iOS audio
 * routes (see "Audio routes on iOS" in the README). Otherwise it stays empty:
 * `available: []`, `selected: null`.
 */
export function useAudioDevices(): AudioDeviceStatus {
  return useObservable(audioDevices$, NO_AUDIO_DEVICES);
}
