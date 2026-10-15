import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

import { logger } from '@signalwire/react';

import type { EmitterSubscription } from 'react-native';

/** An audio route, by the names react-native-incall-manager uses on Android. */
export type AudioDeviceName = 'EARPIECE' | 'SPEAKER_PHONE' | 'WIRED_HEADSET' | 'BLUETOOTH';

/** What the phone can play a call through, and what it is playing through now. */
export interface AudioDeviceStatus {
  readonly available: readonly AudioDeviceName[];
  /** `null` when the current output is none of the four (AirPlay, say), or unknown. */
  readonly selected: AudioDeviceName | null;
  /** The output's own name: the car's or the headset's, e.g. `"KENWOOD"`. */
  readonly selectedName: string;
}

interface NativeAudioRoutes {
  chooseAudioRoute(route: AudioDeviceName): Promise<unknown>;
  getAudioDeviceStatus(): Promise<unknown>;
  addListener(event: string): void;
  removeListeners(count: number): void;
}

const MODULE = 'SWAudioRoutes';
const DEVICE_CHANGED = 'onAudioDeviceChanged';
const NAMES: readonly string[] = ['EARPIECE', 'SPEAKER_PHONE', 'WIRED_HEADSET', 'BLUETOOTH'];
const NONE: AudioDeviceStatus = { available: [], selected: null, selectedName: '' };

let warnedMissing = false;

/**
 * The iOS route module shipped in this package (`ios/SWAudioRoutes.m`), or
 * `null` off iOS. On iOS, `null` means the app was built before this version of
 * the package: native code arrives only with a rebuild.
 */
export function getNativeAudioRoutes(): NativeAudioRoutes | null {
  if (Platform.OS !== 'ios') {
    return null;
  }
  const native = (NativeModules as Record<string, NativeAudioRoutes | undefined> | undefined)?.[MODULE] ?? null;
  if (!native && !warnedMissing) {
    warnedMissing = true;
    logger.warn(
      `${MODULE} is not linked, so iOS audio routes are unavailable. Rebuild the app (pod install) after installing or updating @signalwire/react-native.`
    );
  }
  return native;
}

/** Reads the native status payload: `availableAudioDeviceList` arrives as a JSON string. */
export function parseAudioDeviceStatus(raw: unknown): AudioDeviceStatus {
  if (!raw || typeof raw !== 'object') {
    return NONE;
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
  const available = Array.isArray(list)
    ? list.filter((name): name is AudioDeviceName => NAMES.includes(name as string))
    : [];
  const selected = status.selectedAudioDevice;
  return {
    available,
    selected: typeof selected === 'string' && NAMES.includes(selected) ? (selected as AudioDeviceName) : null,
    selectedName: typeof status.selectedAudioDeviceName === 'string' ? status.selectedAudioDeviceName : ''
  };
}

/** The current audio devices. iOS only: resolves `null` elsewhere, or when the module is not linked. */
export async function getAudioDeviceStatus(): Promise<AudioDeviceStatus | null> {
  const native = getNativeAudioRoutes();
  return native ? parseAudioDeviceStatus(await native.getAudioDeviceStatus()) : null;
}

/**
 * Calls `listener` whenever the audio route changes: a headset or car connects
 * or drops, or the user picks another output. iOS only; elsewhere it never
 * fires. Returns the unsubscribe function.
 */
export function addAudioDeviceChangeListener(listener: (status: AudioDeviceStatus) => void): () => void {
  const native = getNativeAudioRoutes();
  if (!native) {
    return () => undefined;
  }
  const subscription: EmitterSubscription = new NativeEventEmitter(native).addListener(
    DEVICE_CHANGED,
    (raw: unknown) => listener(parseAudioDeviceStatus(raw))
  );
  return () => subscription.remove();
}

/** Test seam: forget that the missing-module warning was logged. */
export function resetNativeAudioRoutesForTesting(): void {
  warnedMissing = false;
}
