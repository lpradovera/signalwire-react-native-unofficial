import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { EMPTY, Observable, ReplaySubject, Subject, defer, filter, map, merge, share, tap } from 'rxjs';

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

/** One status from the native side: a report (`read: null`), or the answer to the read numbered `read`. */
interface FeedItem {
  /** `null` for a read that failed. */
  readonly status: AudioDeviceStatus | null;
  readonly read: number | null;
}

/**
 * The process-wide device feed: one native subscription and one parse per
 * event, shared by the route controller and every `useAudioDevices`, in every
 * bundle copy of this package (so it lives on `globalThis`).
 */
interface DeviceFeed {
  /** Reports and read answers, shared while anyone subscribes; replays the latest to a new subscriber. */
  readonly items$: Observable<FeedItem>;
  readonly reads$: Subject<FeedItem>;
  /** Reads made so far; each read's number. */
  reads: number;
  /** Which native connection is live, or `null`; a read is handed only to the connection it was made in. */
  connection: object | null;
  /** The latest status while connected, for the hook's snapshot. */
  current: AudioDeviceStatus | null;
  /** Ends the live connection (test seam). */
  disconnect: (() => void) | null;
}

const FEED_GLOBAL = '__signalwireRNAudioDevices';

function createFeed(): DeviceFeed {
  const reads$ = new Subject<FeedItem>();
  const feed: { -readonly [K in keyof DeviceFeed]: DeviceFeed[K] } = {
    items$: EMPTY,
    reads$,
    reads: 0,
    connection: null,
    current: null,
    disconnect: null
  };
  const native$ = new Observable<FeedItem>((subscriber) => {
    const routes = incallRoutes();
    if (!routes) {
      return undefined;
    }
    const connection = {};
    feed.connection = connection;
    const listener = routes.addListener(DEVICE_CHANGED, (raw: unknown) => {
      subscriber.next({ status: parseAudioDeviceStatus(raw), read: null });
    });
    read(feed, routes).catch((error: unknown) => logger.warn('Failed to read the audio devices:', error));
    const disconnect = (): void => {
      listener.remove();
      if (feed.connection === connection) {
        feed.connection = null;
        // Nothing follows the devices now: a later subscriber must not be
        // handed this status as current.
        feed.current = null;
        feed.disconnect = null;
      }
    };
    feed.disconnect = disconnect;
    return disconnect;
  });
  feed.items$ = merge(native$, reads$).pipe(
    tap((item) => {
      if (item.status) {
        feed.current = item.status;
      }
    }),
    share({ connector: () => new ReplaySubject<FeedItem>(1), resetOnRefCountZero: true })
  );
  return feed;
}

function deviceFeed(): DeviceFeed {
  return processGlobal<DeviceFeed>(FEED_GLOBAL, createFeed);
}

/**
 * Reads the status (called now, in order with every other native call) and
 * hands the answer to the connection that was live when it was made.
 * incall-manager answers the read on the same serial queue it sends its
 * events from, so the answer is at least as new as every event that reached
 * JavaScript before it, and every event after it is newer.
 */
function read(feed: DeviceFeed, routes: IncallRoutesApi): Promise<AudioDeviceStatus> {
  feed.reads += 1;
  const number = feed.reads;
  const connection = feed.connection;
  const live = (): boolean => connection !== null && feed.connection === connection;
  let answer: Promise<unknown>;
  try {
    answer = Promise.resolve(routes.getAudioDeviceStatus());
  } catch (error) {
    answer = Promise.reject(error);
  }
  return answer.then(
    (raw) => {
      const status = parseAudioDeviceStatus(raw);
      if (live()) {
        feed.reads$.next({ status, read: number });
      }
      return status;
    },
    (error: unknown) => {
      if (live()) {
        feed.reads$.next({ status: null, read: number });
      }
      throw error;
    }
  );
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
  return routes ? read(deviceFeed(), routes) : null;
}

/**
 * The audio devices: the current status on subscribe, then each
 * `onAudioDeviceChanged`. Shared process-wide, so every subscriber sees the
 * same status from one native subscription and one parse per event. Never
 * emits without iOS routes. incall-manager reports changes only while a
 * call's session runs, so outside a call this holds the last status read.
 */
export const audioDevices$: Observable<AudioDeviceStatus> = defer(() => deviceFeed().items$).pipe(
  map((item) => item.status),
  filter((status): status is AudioDeviceStatus => status !== null)
);

/**
 * @internal The devices from now on, for a call's session: the replayed
 * status and the reports before a read made after subscribing (they describe
 * the session before this call) are skipped. The first value is that read's
 * answer, or `null` if it failed; reports follow. Makes one read: the feed's
 * own connect read when this subscription connects it, else one of its own.
 */
export function sessionAudioDevices$(): Observable<AudioDeviceStatus | null> {
  return new Observable<AudioDeviceStatus | null>((subscriber) => {
    const routes = incallRoutes();
    if (!routes) {
      return undefined;
    }
    const feed = deviceFeed();
    const first = feed.reads + 1;
    let open = false;
    const subscription = feed.items$.subscribe((item) => {
      if (!open) {
        if (item.read === null || item.read < first) {
          return;
        }
        open = true;
        subscriber.next(item.status);
        return;
      }
      if (item.status) {
        subscriber.next(item.status);
      }
    });
    if (feed.reads < first) {
      // The feed was already connected: nothing read since this subscribed.
      read(feed, routes).catch((error: unknown) => logger.warn('Failed to read the audio devices:', error));
    }
    return () => subscription.unsubscribe();
  });
}

/** For `useSyncExternalStore`: subscribes to the feed (once per mount; no render-time read). */
export function subscribeAudioDevices(onChange: () => void): () => void {
  const subscription = audioDevices$.subscribe(() => onChange());
  return () => subscription.unsubscribe();
}

/** For `useSyncExternalStore`: the feed's current status, or the empty one. */
export function currentAudioDevices(): AudioDeviceStatus {
  return peekProcessGlobal<DeviceFeed>(FEED_GLOBAL)?.current ?? NO_AUDIO_DEVICES;
}

/**
 * @internal incall-manager's Android device reports (`onAudioDeviceChanged`,
 * sent through DeviceEventEmitter by every version: 4.2.x has no wrapper
 * `addListener`). They come from its device update, which `start()` and every
 * route change run, while its session runs.
 */
export function androidAudioDeviceReports$(): Observable<AudioDeviceStatus> {
  return new Observable<AudioDeviceStatus>((subscriber) => {
    const listener = DeviceEventEmitter.addListener(DEVICE_CHANGED, (raw: unknown) => {
      subscriber.next(parseAudioDeviceStatus(raw));
    });
    return () => listener.remove();
  });
}

/** Test seam: drops the device feed and its native subscription at once. */
export function resetAudioDevicesForTesting(): void {
  const feed = peekProcessGlobal<DeviceFeed>(FEED_GLOBAL);
  feed?.disconnect?.();
  feed?.reads$.complete();
  dropProcessGlobal(FEED_GLOBAL);
}
