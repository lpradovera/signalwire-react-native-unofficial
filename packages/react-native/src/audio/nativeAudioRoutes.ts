import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { Observable, shareReplay } from 'rxjs';

import { logger } from '@signalwire/react';

/** Audio routes by react-native-incall-manager's names. */
const NAMES = ['EARPIECE', 'SPEAKER_PHONE', 'WIRED_HEADSET', 'BLUETOOTH'] as const;

/** An audio route, by the names react-native-incall-manager uses. */
export type AudioDeviceName = (typeof NAMES)[number];

/** What the phone can play a call through, and what it is playing through now. */
export interface AudioDeviceStatus {
  readonly available: readonly AudioDeviceName[];
  /** `null` when the current output is none of the four (AirPlay, say), or unknown. */
  readonly selected: AudioDeviceName | null;
  /** The output's own name: the car's or the headset's, e.g. `"KENWOOD"`. */
  readonly selectedName: string;
}

/** The status before anything is known, and off iOS. */
export const NO_AUDIO_DEVICES: AudioDeviceStatus = { available: [], selected: null, selectedName: '' };

const DEVICE_CHANGED = 'onAudioDeviceChanged';

/** The parts of incall-manager's iOS native module that its iOS routes add. */
interface IncallNativeRoutes {
  getAudioDeviceStatus(): Promise<unknown>;
  addListener(event: string): void;
  removeListeners(count: number): void;
}

function isName(value: unknown): value is AudioDeviceName {
  return (NAMES as readonly unknown[]).includes(value);
}

/**
 * incall-manager's native module, when it has iOS audio routes
 * (`chooseAudioRoute`, `getAudioDeviceStatus`, `onAudioDeviceChanged`).
 * Released versions (through 4.3.0) have them on Android only; the upstream
 * change, or the patch in docs/patches, adds them on iOS. `null` off iOS.
 */
function incallNativeRoutes(): IncallNativeRoutes | null {
  if (Platform.OS !== 'ios') {
    return null;
  }
  const native = (NativeModules as Record<string, Partial<IncallNativeRoutes> | undefined> | undefined)
    ?.InCallManager;
  return typeof native?.getAudioDeviceStatus === 'function' ? (native as IncallNativeRoutes) : null;
}

/** Whether this iOS app's incall-manager can choose and report routes beyond speaker on/off. */
export function hasIosAudioRoutes(): boolean {
  return incallNativeRoutes() !== null;
}

/** Reads the native status payload: `availableAudioDeviceList` arrives as a JSON string. */
export function parseAudioDeviceStatus(raw: unknown): AudioDeviceStatus {
  if (!raw || typeof raw !== 'object') {
    return NO_AUDIO_DEVICES;
  }
  const status = raw as Record<string, unknown>;
  let list = status.availableAudioDeviceList;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list) as unknown;
    } catch {
      list = [];
    }
  }
  const selected = status.selectedAudioDevice;
  return {
    available: Array.isArray(list) ? list.filter(isName) : [],
    selected: isName(selected) ? selected : null,
    selectedName: typeof status.selectedAudioDeviceName === 'string' ? status.selectedAudioDeviceName : ''
  };
}

/**
 * The current audio devices. iOS only, and only with an incall-manager that
 * has iOS routes: resolves `null` otherwise.
 */
export async function getAudioDeviceStatus(): Promise<AudioDeviceStatus | null> {
  const native = incallNativeRoutes();
  return native ? parseAudioDeviceStatus(await native.getAudioDeviceStatus()) : null;
}

/**
 * The audio devices, kept current: the status once on subscribe, then each
 * `onAudioDeviceChanged`. Shared, so every subscriber (the route controller,
 * each `useAudioDevices`) sees the same status from one native subscription
 * and one parse per event. Never emits without iOS routes.
 *
 * The event is subscribed through a NativeEventEmitter on incall-manager's
 * module: on iOS, RCTEventEmitter sends only to those.
 */
export const audioDevices$: Observable<AudioDeviceStatus> = new Observable<AudioDeviceStatus>((subscriber) => {
  const native = incallNativeRoutes();
  if (!native) {
    return undefined;
  }
  let heard = false;
  const subscription = new NativeEventEmitter(native).addListener(DEVICE_CHANGED, (raw: unknown) => {
    heard = true;
    subscriber.next(parseAudioDeviceStatus(raw));
  });
  native
    .getAudioDeviceStatus()
    .then((raw) => {
      // A change that arrived while this was in flight is newer than it.
      if (!heard && !subscriber.closed) {
        subscriber.next(parseAudioDeviceStatus(raw));
      }
    })
    .catch((error: unknown) => logger.warn('Failed to read the audio devices:', error));
  return () => subscription.remove();
}).pipe(shareReplay({ bufferSize: 1, refCount: true }));
