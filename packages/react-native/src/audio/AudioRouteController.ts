import { Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { BehaviorSubject } from 'rxjs';

import { logger } from '@signalwire/react';
import { assertPeerModule } from '../platform/peers';
import { addAudioDeviceChangeListener, getNativeAudioRoutes } from './nativeAudioRoutes';

import type { Observable } from 'rxjs';
import type { AudioDeviceName, AudioDeviceStatus } from './nativeAudioRoutes';

export type AudioRoute = 'earpiece' | 'speaker' | 'bluetooth';

/** A route, and whether the user picked it or it is the call's default. */
interface RouteState {
  readonly route: AudioRoute;
  readonly chosen: boolean;
}

const DEFAULT_ROUTE: RouteState = { route: 'earpiece', chosen: false };

/**
 * How long the route changes iOS posts after one of our own requests are taken
 * as that request still landing, rather than as a change from elsewhere.
 */
const SETTLE_MS = 500;

/** The route a device stands for. A wired headset reads as `'earpiece'`: off the speaker. */
const ROUTE_FOR_DEVICE: Record<AudioDeviceName, AudioRoute> = {
  EARPIECE: 'earpiece',
  SPEAKER_PHONE: 'speaker',
  WIRED_HEADSET: 'earpiece',
  BLUETOOTH: 'bluetooth'
};

/** The device a route needs connected, for routes that need one. */
const DEVICE_FOR_ROUTE: Partial<Record<AudioRoute, AudioDeviceName>> = { bluetooth: 'BLUETOOTH' };

/**
 * Owns the native audio session and output routing.
 *
 * `'bluetooth'` is a *request*: the OS makes the final routing decision. On
 * iOS, `route` then follows what it settled on, including a choice made in the
 * system route picker or a headset or car connecting; `useAudioDevices()` has
 * the detail (which device, by name).
 *
 * On iOS two native modules touch the audio session, and each owns one part:
 * react-native-incall-manager owns the category, the mode and the speaker
 * override, through its force-speaker flag, which it re-applies on every
 * category change; this package's SWAudioRoutes owns only which device a call
 * uses off the speaker (the preferred input). So every route sets
 * incall-manager's flag to match (speaker on, earpiece off, Bluetooth default)
 * before SWAudioRoutes picks the device, and a route change from outside is
 * written back to that flag.
 */
export class AudioRouteController {
  private readonly _route$ = new BehaviorSubject<AudioRoute>('earpiece');
  /** Whether the current route is the user's choice, not the call's default. */
  private chosen = false;
  /** What turning the speaker off returns to. */
  private beforeSpeaker: RouteState = DEFAULT_ROUTE;
  private started = false;
  private destroyed = false;
  /** The media the running session was started for. */
  private media: 'audio' | 'video' = 'audio';
  private stopFollowing: (() => void) | null = null;
  /** Until when route changes are taken as our own request landing. */
  private settleUntil = 0;

  constructor() {
    assertPeerModule(
      InCallManager as object | undefined,
      'react-native-incall-manager',
      'audio routing',
      'start'
    );
  }

  get route$(): Observable<AudioRoute> {
    return this._route$.asObservable();
  }

  get route(): AudioRoute {
    return this._route$.value;
  }

  /** Begins the native audio session. Video calls default to speaker. */
  start(media: 'audio' | 'video'): void {
    // Idempotent: an answered inbound call starts audio on the native answer
    // and again when it reaches `connected`. Restarting would re-run
    // InCallManager and force the route back to its default, discarding a
    // speaker toggle the user had already made.
    if (this.started) {
      return;
    }
    try {
      InCallManager.start({ media });
      this.started = true;
      logger.debug(`Audio session started (${media})`);
    } catch (error) {
      logger.warn('Failed to start the audio session:', error);
    }
    this.stopFollowing ??= addAudioDeviceChangeListener((status) => this.followDevice(status));
    this.media = media;
    this.beforeSpeaker = DEFAULT_ROUTE;
    this.select(media === 'video' ? 'speaker' : 'earpiece', false);
  }

  /**
   * Tells a running session its call's media, when it was started before that
   * was known: a pushed call answered before its SDK call existed starts in
   * the app's mode, and its call (or the call placed to join it) can turn out
   * to be voice only. Moves to that media's default route (video on the
   * speaker, voice off it), unless the user already picked a route.
   */
  updateMedia(media: 'audio' | 'video'): void {
    if (!this.started || media === this.media) {
      return;
    }
    this.media = media;
    if (!this.chosen) {
      this.beforeSpeaker = DEFAULT_ROUTE;
      this.select(media === 'video' ? 'speaker' : 'earpiece', false);
    }
  }

  /** Ends the native audio session and resets to the earpiece. */
  stop(): void {
    try {
      if (this.started) {
        InCallManager.stop();
      }
    } catch (error) {
      logger.warn('Failed to stop the audio session:', error);
    }
    this.started = false;
    this.stopFollowing?.();
    this.stopFollowing = null;
    this.applyRoute('earpiece');
    this.chosen = false;
    this.beforeSpeaker = DEFAULT_ROUTE;
    if (!this.destroyed) {
      this._route$.next('earpiece');
    }
  }

  /**
   * Requests an output route, as the user's choice: `'earpiece'` moves a call
   * off a connected Bluetooth headset or car onto the phone itself. For a
   * speaker on/off toggle use {@link setSpeakerOn}, whose "off" returns to the
   * call's default instead.
   *
   * @param force - Re-applies even when the route is unchanged.
   */
  setRoute(route: AudioRoute, force = false): void {
    if (!force && route === this._route$.value && this.chosen) {
      return;
    }
    this.select(route, true);
  }

  /**
   * Turns the loudspeaker on, or off again. Off returns to the route the call
   * had before the speaker: the user's earlier choice, or else the default,
   * where iOS plays a call through a connected headset or car and otherwise
   * the receiver. It never pins the call to the receiver the way
   * `setRoute('earpiece')` does.
   */
  setSpeakerOn(on: boolean): void {
    if (on) {
      if (this._route$.value !== 'speaker') {
        this.select('speaker', true);
      }
      return;
    }
    if (this._route$.value === 'speaker') {
      const { route, chosen } = this.beforeSpeaker;
      this.select(route, chosen);
    }
  }

  private select(route: AudioRoute, chosen: boolean): void {
    if (route === 'speaker' && this._route$.value !== 'speaker') {
      this.beforeSpeaker = { route: this._route$.value, chosen: this.chosen };
    }
    this.settleUntil = Date.now() + SETTLE_MS;
    this.applyRoute(route, chosen);
    this.chosen = chosen;
    this._route$.next(route);
  }

  /**
   * Takes on a route iOS settled on by itself: the system route picker
   * (AVRoutePickerView), or a headset or car connecting or dropping. Without
   * this `route` (and the speaker toggle) would go stale, and incall-manager,
   * still holding the old speaker flag, would undo the change on its next
   * category-change re-apply.
   */
  private followDevice(status: AudioDeviceStatus): void {
    if (!this.started || !status.selected || Date.now() < this.settleUntil) {
      return;
    }
    const route = ROUTE_FOR_DEVICE[status.selected];
    const previous = this._route$.value;
    if (route === previous) {
      return;
    }
    if (route === 'speaker') {
      // Speaker off returns to where the call was, if that device is still there.
      const needs = DEVICE_FOR_ROUTE[previous];
      this.beforeSpeaker =
        needs && !status.available.includes(needs) ? DEFAULT_ROUTE : { route: previous, chosen: this.chosen };
      this.setIncallSpeakerFlag(route);
    } else if (previous === 'speaker') {
      this.setIncallSpeakerFlag(route);
    }
    // Nothing of ours pins this route.
    this.chosen = false;
    this._route$.next(route);
  }

  /** incall-manager's force-speaker flag for a route: on, off, or its default (null). */
  private setIncallSpeakerFlag(route: AudioRoute): void {
    const flag = route === 'speaker' ? true : route === 'earpiece' ? false : null;
    try {
      InCallManager.setForceSpeakerphoneOn(flag as boolean);
    } catch (error) {
      logger.warn(`Failed to apply audio route "${route}":`, error);
    }
  }

  /**
   * @param chosen - The user asked for this route, as opposed to `start()` and
   *   `stop()` setting the default. Only a choice moves a call off a connected
   *   Bluetooth headset or car onto the earpiece.
   */
  private applyRoute(route: AudioRoute, chosen = false): void {
    // chooseAudioRoute returns a promise: a failure is a rejection, which the
    // try/catch below never sees. react-native-incall-manager implements it on
    // Android only, so iOS uses this package's own module (SWAudioRoutes).
    const choose = (name: 'BLUETOOTH' | 'EARPIECE'): void => {
      const chosen =
        Platform.OS === 'ios'
          ? getNativeAudioRoutes()?.chooseAudioRoute(name)
          : InCallManager.chooseAudioRoute(name);
      Promise.resolve(chosen).catch((error: unknown) =>
        logger.warn(`Failed to apply audio route "${route}":`, error)
      );
    };
    try {
      if (route === 'bluetooth') {
        if (Platform.OS === 'ios') {
          // incall-manager keeps its own speaker flag and re-applies it on
          // every audio category change: left at "on" from an earlier speaker
          // choice, it would put the loudspeaker back under the headset. Its
          // "default" (null) clears the override, and on its own already lets
          // iOS route to a connected headset or car.
          InCallManager.setForceSpeakerphoneOn(null as unknown as boolean);
        }
        choose('BLUETOOTH');
        return;
      }
      // Off (-1) also takes a video call out of the video-chat mode, which
      // would otherwise keep it on the speaker; incall-manager switches the
      // mode with the flag.
      InCallManager.setForceSpeakerphoneOn(route === 'speaker');
      // On iOS, turning the speaker off leaves a connected Bluetooth device in
      // charge (iOS routes calls to it): only the preferred input moves a call
      // to the phone itself.
      if (route === 'earpiece' && Platform.OS === 'ios') {
        if (chosen) {
          choose('EARPIECE');
        } else {
          // The default route: drop a receiver pin an earlier choice left, so
          // iOS goes back to a connected headset or car.
          const cleared = getNativeAudioRoutes()?.clearPreferredInput();
          Promise.resolve(cleared).catch((error: unknown) =>
            logger.warn('Failed to reset the audio route:', error)
          );
        }
      }
    } catch (error) {
      logger.warn(`Failed to apply audio route "${route}":`, error);
    }
  }

  /**
   * Releases the audio session. Idempotent, and deliberately silent: emitting
   * a route change while tearing down would push a value at subscribers that
   * are themselves unmounting.
   */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.stop();
    this._route$.complete();
  }
}

/** Same duplication hazard as the CallKit bridge — see its note. One audio
 * session exists per app, so the controller must be per-process, and only
 * `globalThis` is shared across the subpath entry bundles. */
const AUDIO_GLOBAL = '__signalwireRNAudioRoute';

type AudioHolder = { [AUDIO_GLOBAL]?: AudioRouteController };

/** The process-wide audio route controller. One audio session exists per app. */
export function getAudioRouteController(): AudioRouteController {
  const holder = globalThis as AudioHolder;
  holder[AUDIO_GLOBAL] ??= new AudioRouteController();
  return holder[AUDIO_GLOBAL];
}

/** Test seam — drops the singleton. */
export function resetAudioRouteControllerForTesting(): void {
  const holder = globalThis as AudioHolder;
  holder[AUDIO_GLOBAL]?.destroy();
  delete holder[AUDIO_GLOBAL];
}
