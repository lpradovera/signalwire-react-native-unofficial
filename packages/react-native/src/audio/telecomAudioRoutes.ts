import { DeviceEventEmitter, NativeModules } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { Observable } from 'rxjs';

import { logger } from '@signalwire/react';

import type { AudioDeviceName, AudioDeviceStatus } from './nativeAudioRoutes';

/**
 * Android call audio through Telecom, for a call that react-native-callkeep's
 * self-managed ConnectionService holds.
 *
 * Telecom routes such a call itself: the receiver, the speaker, a wired
 * headset or Bluetooth (SCO included), and it sets the audio mode and takes
 * audio focus for it. It reports each change through the connection's
 * onCallAudioStateChanged, which callkeep forwards as `didChangeAudioRoute`.
 * incall-manager's start() would route the same call through AudioManager
 * behind Telecom's back (its own speaker default, and its Bluetooth manager,
 * which starts SCO whatever its `auto` flag says), and the two disagree: Telecom
 * keeps its route while incall-manager forces another. So a Telecom call never
 * starts incall-manager's session; {@link startTelecomCallScreen} does the rest
 * of what that session did.
 *
 * The native modules are used directly rather than callkeep's JS wrapper,
 * which this subpath does not import: callkeep's `setAudioRoute` forwards to
 * the native method unchanged, and its events reach JavaScript through
 * DeviceEventEmitter on Android.
 */

/** callkeep's setAudioRoute names. Anything else is Telecom's ROUTE_WIRED_OR_EARPIECE, which is the receiver unless a wired headset is in. */
const CALLKEEP_ROUTE: Record<AudioDeviceName, string> = {
  EARPIECE: 'Phone',
  SPEAKER_PHONE: 'Speaker',
  WIRED_HEADSET: 'Headset',
  BLUETOOTH: 'Bluetooth'
};

/** CallAudioState.audioRouteToString's names, which callkeep's event and the package's reader send. */
const DEVICE_FOR_TELECOM: Record<string, AudioDeviceName> = {
  EARPIECE: 'EARPIECE',
  SPEAKER: 'SPEAKER_PHONE',
  WIRED_HEADSET: 'WIRED_HEADSET',
  BLUETOOTH: 'BLUETOOTH'
};

const ROUTE_CHANGED = 'RNCallKeepDidChangeAudioRoute';

function deviceFor(name: unknown): AudioDeviceName | null {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(DEVICE_FOR_TELECOM, name)
    ? (DEVICE_FOR_TELECOM[name] ?? null)
    : null;
}

function sameCall(a: unknown, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

interface CallKeepNative {
  setAudioRoute(uuid: string, route: string): Promise<unknown> | unknown;
}

/** The package's own reader of a call's CallAudioState (android/…/CallAudioStateModule.java). */
interface CallAudioNative {
  getCallAudioState(uuid: string): Promise<unknown>;
}

function nativeModule<T>(name: string, method: keyof T): T | null {
  const native = (NativeModules as Record<string, Partial<T> | undefined> | undefined)?.[name];
  return typeof native?.[method] === 'function' ? (native as T) : null;
}

/** Whether callkeep's native module can route a call through Telecom (callkeep linked). */
export function hasTelecomRouting(): boolean {
  return nativeModule<CallKeepNative>('RNCallKeep', 'setAudioRoute') !== null;
}

/** A Telecom status: the route the call is on and, from the package's reader, the routes Telecom offers it. */
export interface TelecomAudioStatus extends AudioDeviceStatus {
  /**
   * Whether `available` is Telecom's: false without the package's Android
   * library (an app not rebuilt), where only callkeep's route is known.
   */
  readonly availableKnown: boolean;
}

/** Reads the call's CallAudioState: `null` without the reader, the connection, or a state yet. */
export async function readTelecomAudio(uuid: string): Promise<TelecomAudioStatus | null> {
  const native = nativeModule<CallAudioNative>('SignalWireCallAudio', 'getCallAudioState');
  if (!native) {
    return null;
  }
  const raw = (await native.getCallAudioState(uuid)) as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const list: unknown[] = Array.isArray(raw.available) ? raw.available : [];
  return {
    available: list.map(deviceFor).filter((device): device is AudioDeviceName => device !== null),
    availableKnown: true,
    selected: deviceFor(raw.route),
    selectedName: typeof raw.bluetoothName === 'string' ? raw.bluetoothName : ''
  };
}

function routeOnly(selected: AudioDeviceName): TelecomAudioStatus {
  return { available: [], availableKnown: false, selected, selectedName: '' };
}

/**
 * The call's Telecom status after each `didChangeAudioRoute` for it: a
 * choice in the system's output switcher, a headset or car connecting or
 * dropping, the app's own request. callkeep sends only the route, so each
 * report is read through the package's reader when it is linked.
 */
export function telecomAudioReports$(uuid: string): Observable<TelecomAudioStatus> {
  return new Observable<TelecomAudioStatus>((subscriber) => {
    let open = true;
    const listener = DeviceEventEmitter.addListener(ROUTE_CHANGED, (event: unknown) => {
      const payload = (event ?? {}) as { callUUID?: unknown; output?: unknown };
      if (!sameCall(payload.callUUID, uuid)) {
        return;
      }
      const reported = deviceFor(payload.output);
      const fallback = (): void => {
        if (open && reported) {
          subscriber.next(routeOnly(reported));
        }
      };
      readTelecomAudio(uuid).then(
        (status) => {
          if (!open) {
            return;
          }
          if (status?.selected) {
            subscriber.next(status);
          } else {
            fallback();
          }
        },
        (error: unknown) => {
          logger.warn('Failed to read the call audio state:', error);
          fallback();
        }
      );
    });
    return () => {
      open = false;
      listener.remove();
    };
  });
}

/**
 * Asks Telecom to move the call (Connection.setAudioRoute, through callkeep);
 * what Telecom does arrives as a report. Nothing waits on callkeep's promise:
 * 4.3.16 never settles it when it has no such connection.
 */
export function requestTelecomRoute(uuid: string, device: AudioDeviceName): void {
  const native = nativeModule<CallKeepNative>('RNCallKeep', 'setAudioRoute');
  if (!native) {
    return;
  }
  try {
    Promise.resolve(native.setAudioRoute(uuid, CALLKEEP_ROUTE[device])).catch((error: unknown) =>
      logger.warn(`Failed to ask Telecom for audio route ${device}:`, error)
    );
  } catch (error) {
    logger.warn(`Failed to ask Telecom for audio route ${device}:`, error);
  }
}

type ScreenMethod = 'setKeepScreenOn' | 'startProximitySensor' | 'stopProximitySensor' | 'turnScreenOn' | 'turnScreenOff';

/** The package's proximity screen-off lock (ProximityScreenModule). */
interface ProximityScreenNative {
  setHeld(hold: boolean, waitForFar: boolean): void;
}

/**
 * What incall-manager's session did for a call besides routing, through its
 * single-purpose methods instead of start(): the screen kept on, and blanked
 * while the phone is held to the ear on the receiver (a self-managed call has
 * no system in-call UI to do it). Telecom sets the audio mode and takes audio
 * focus. Returns the teardown.
 *
 * Blanking is the system's: the package's ProximityScreenModule holds a
 * PROXIMITY_SCREEN_OFF_WAKE_LOCK while the route is the receiver, and the
 * system turns the screen off when something is near and on when it goes
 * away. The lock is released at once on any other route, and at the end of
 * the call once the phone has left the ear. An app whose native code predates
 * the module (not rebuilt) falls back to incall-manager's sensor, which blanks
 * the screen only once JavaScript has seen its "near" event.
 */
export function startTelecomCallScreen(route$: Observable<string>): () => void {
  const manager = InCallManager as unknown as Partial<Record<ScreenMethod, (enable?: boolean) => void>>;
  const call = (name: ScreenMethod, enable?: boolean): void => {
    try {
      const method = manager[name];
      if (typeof method === 'function') {
        if (enable === undefined) {
          method.call(manager);
        } else {
          method.call(manager, enable);
        }
      }
    } catch (error) {
      logger.warn(`incall-manager ${name} failed:`, error);
    }
  };
  call('setKeepScreenOn', true);
  const lock = nativeModule<ProximityScreenNative>('SignalWireProximityScreen', 'setHeld');
  const stopBlanking = lock ? holdProximityLock(lock, route$) : blankOnSensor(call, route$);
  return () => {
    stopBlanking();
    call('setKeepScreenOn', false);
  };
}

/** Holds the proximity screen-off lock while `route$` is the receiver. Returns the release. */
function holdProximityLock(lock: ProximityScreenNative, route$: Observable<string>): () => void {
  let held = false;
  const set = (hold: boolean, waitForFar: boolean): void => {
    if (hold === held) {
      return;
    }
    held = hold;
    try {
      lock.setHeld(hold, waitForFar);
    } catch (error) {
      logger.warn('Failed to set the proximity screen-off lock:', error);
    }
  };
  const routes = route$.subscribe((route) => set(route === 'earpiece', false));
  return () => {
    routes.unsubscribe();
    set(false, true);
  };
}

/** incall-manager's sensor: blanks the screen on a "near" event while `route$` is the receiver. */
function blankOnSensor(call: (name: ScreenMethod) => void, route$: Observable<string>): () => void {
  let near = false;
  let route = '';
  let blanked = false;
  const update = (): void => {
    const blank = near && route === 'earpiece';
    if (blank !== blanked) {
      blanked = blank;
      call(blank ? 'turnScreenOff' : 'turnScreenOn');
    }
  };
  call('startProximitySensor');
  const proximity = DeviceEventEmitter.addListener('Proximity', (event: unknown) => {
    near = (event as { isNear?: unknown } | undefined)?.isNear === true;
    update();
  });
  const routes = route$.subscribe((next) => {
    route = next;
    update();
  });
  return () => {
    proximity.remove();
    routes.unsubscribe();
    call('stopProximitySensor');
    if (blanked) {
      blanked = false;
      call('turnScreenOn');
    }
  };
}
