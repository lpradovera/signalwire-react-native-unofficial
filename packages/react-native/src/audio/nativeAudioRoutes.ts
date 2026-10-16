import { NativeModules, Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { BehaviorSubject, Observable, filter } from 'rxjs';

import { logger } from '@signalwire/react';
import { dropProcessGlobal, peekProcessGlobal, processGlobal } from '../platform/processGlobal';

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

/**
 * How long the native subscription outlives its last subscriber. A hook's
 * first render subscribes and unsubscribes at once to read the current value,
 * then subscribes again from its effect: without the grace period each mount
 * would connect twice (two reads, and incall-manager resets its event dedup
 * on every disconnect).
 */
const RELEASE_DELAY_MS = 1000;

/** The parts of incall-manager's JS API that its iOS routes add. */
interface IncallRoutesApi {
  getAudioDeviceStatus(): Promise<unknown>;
  addListener(event: string, listener: (raw: unknown) => void): { remove(): void };
}

function isName(value: unknown): value is AudioDeviceName {
  return (NAMES as readonly unknown[]).includes(value);
}

/**
 * incall-manager's JS API, when it has iOS audio routes (`chooseAudioRoute`,
 * `getAudioDeviceStatus`, `onAudioDeviceChanged`). Released versions (through
 * 4.3.0) have them on Android only; the upstream change, or the patch in
 * docs/patches, adds them on iOS. `null` off iOS.
 *
 * Both halves are checked: the native module (an app rebuilt with the
 * routes) and the JS wrapper (an older JS bundle over a rebuilt app, or the
 * reverse, has only one of them and is treated as having no routes).
 */
function incallRoutes(): IncallRoutesApi | null {
  if (Platform.OS !== 'ios') {
    return null;
  }
  const native = (NativeModules as Record<string, { getAudioDeviceStatus?: unknown } | undefined> | undefined)
    ?.InCallManager;
  const api = InCallManager as unknown as Partial<IncallRoutesApi> | undefined;
  if (
    typeof native?.getAudioDeviceStatus !== 'function' ||
    typeof api?.getAudioDeviceStatus !== 'function' ||
    typeof api.addListener !== 'function'
  ) {
    return null;
  }
  return api as IncallRoutesApi;
}

/** Whether this iOS app's incall-manager can choose and report routes beyond speaker on/off. */
export function hasIosAudioRoutes(): boolean {
  return incallRoutes() !== null;
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
 * The process-wide device feed: one native subscription and one parse per
 * event, shared by the route controller and every `useAudioDevices`, in every
 * bundle copy of this package.
 */
interface DeviceFeed {
  /** The latest status; `null` while nothing is known (not connected). */
  readonly status$: BehaviorSubject<AudioDeviceStatus | null>;
  subscribers: number;
  listener: { remove(): void } | null;
  release: ReturnType<typeof setTimeout> | null;
}

const FEED_GLOBAL = '__signalwireRNAudioDevices';

function deviceFeed(): DeviceFeed {
  return processGlobal<DeviceFeed>(FEED_GLOBAL, () => ({
    status$: new BehaviorSubject<AudioDeviceStatus | null>(null),
    subscribers: 0,
    listener: null,
    release: null
  }));
}

/**
 * Reads the status and makes it the feed's current one. incall-manager
 * answers the read on the same serial queue it sends its events from, so the
 * answer is at least as new as every event that reached JavaScript before
 * it, and every event after it is newer.
 */
async function readInto(feed: DeviceFeed | undefined, routes: IncallRoutesApi): Promise<AudioDeviceStatus> {
  const status = parseAudioDeviceStatus(await routes.getAudioDeviceStatus());
  if (feed?.listener) {
    feed.status$.next(status);
  }
  return status;
}

function connect(feed: DeviceFeed, routes: IncallRoutesApi): void {
  feed.subscribers += 1;
  if (feed.release !== null) {
    clearTimeout(feed.release);
    feed.release = null;
  }
  if (feed.listener) {
    return;
  }
  feed.listener = routes.addListener(DEVICE_CHANGED, (raw: unknown) => {
    feed.status$.next(parseAudioDeviceStatus(raw));
  });
  readInto(feed, routes).catch((error: unknown) => logger.warn('Failed to read the audio devices:', error));
}

function disconnect(feed: DeviceFeed): void {
  feed.subscribers -= 1;
  if (feed.subscribers > 0 || feed.release !== null) {
    return;
  }
  feed.release = setTimeout(() => {
    feed.release = null;
    if (feed.subscribers === 0 && feed.listener) {
      feed.listener.remove();
      feed.listener = null;
      // Nothing follows the devices now: the next subscriber must not be
      // handed this status as current.
      feed.status$.next(null);
    }
  }, RELEASE_DELAY_MS);
}

/**
 * Reads the audio devices now, and hands the result to every
 * {@link audioDevices$} subscriber. iOS only, and only with an incall-manager
 * that has iOS routes: resolves `null` otherwise.
 *
 * The status follows headsets and cars only while a call's session runs
 * (between incall-manager's `start()` and `stop()`); outside a call it
 * describes the app's own audio session, which usually lists only the
 * receiver, the speaker and the current media output.
 */
export async function getAudioDeviceStatus(): Promise<AudioDeviceStatus | null> {
  const routes = incallRoutes();
  return routes ? readInto(peekProcessGlobal<DeviceFeed>(FEED_GLOBAL), routes) : null;
}

/**
 * The audio devices: the current status on subscribe, then each
 * `onAudioDeviceChanged`. Shared process-wide, so every subscriber sees the
 * same status from one native subscription and one parse per event. Never
 * emits without iOS routes. incall-manager reports changes only while a
 * call's session runs, so outside a call this holds the last status read.
 */
export const audioDevices$: Observable<AudioDeviceStatus> = new Observable<AudioDeviceStatus>((subscriber) => {
  const routes = incallRoutes();
  if (!routes) {
    return undefined;
  }
  const feed = deviceFeed();
  connect(feed, routes);
  const subscription = feed.status$
    .pipe(filter((status): status is AudioDeviceStatus => status !== null))
    .subscribe(subscriber);
  return () => {
    subscription.unsubscribe();
    disconnect(feed);
  };
});

/** Test seam: drops the device feed and its native subscription at once. */
export function resetAudioDevicesForTesting(): void {
  const feed = peekProcessGlobal<DeviceFeed>(FEED_GLOBAL);
  if (feed) {
    if (feed.release !== null) {
      clearTimeout(feed.release);
    }
    feed.listener?.remove();
    feed.status$.complete();
  }
  dropProcessGlobal(FEED_GLOBAL);
}
