import { Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { BehaviorSubject } from 'rxjs';

import { logger } from '@signalwire/react';
import { assertPeerModule } from '../platform/peers';

import type { Observable } from 'rxjs';

export type AudioRoute = 'earpiece' | 'speaker' | 'bluetooth';

/** A route, and whether the user picked it or it is the call's default. */
interface RouteState {
  readonly route: AudioRoute;
  readonly chosen: boolean;
}

const DEFAULT_ROUTE: RouteState = { route: 'earpiece', chosen: false };

/**
 * Owns the native audio session and output routing.
 *
 * `'bluetooth'` is a *request*: the OS makes the final routing decision and
 * InCallManager cannot reliably report the active device, so `route` reflects
 * what was asked for, not necessarily what the OS settled on.
 */
export class AudioRouteController {
  private readonly _route$ = new BehaviorSubject<AudioRoute>('earpiece');
  /** Whether the current route is the user's choice, not the call's default. */
  private chosen = false;
  /** What turning the speaker off returns to. */
  private beforeSpeaker: RouteState = DEFAULT_ROUTE;
  private started = false;
  private destroyed = false;

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
    this.beforeSpeaker = DEFAULT_ROUTE;
    this.select(media === 'video' ? 'speaker' : 'earpiece', false);
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
    this.applyRoute(route, chosen);
    this.chosen = chosen;
    this._route$.next(route);
  }

  /**
   * @param chosen - The user asked for this route, as opposed to `start()` and
   *   `stop()` setting the default. Only a choice moves a call off a connected
   *   Bluetooth headset or car onto the earpiece.
   */
  private applyRoute(route: AudioRoute, chosen = false): void {
    // chooseAudioRoute returns a promise: a failure is a rejection, which the
    // try/catch below never sees. On iOS the native method doesn't exist
    // before react-native-incall-manager's iOS routes, so every call to it
    // rejected, unhandled.
    const choose = (name: 'BLUETOOTH' | 'EARPIECE'): void => {
      Promise.resolve(InCallManager.chooseAudioRoute(name)).catch((error: unknown) =>
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
      InCallManager.setForceSpeakerphoneOn(route === 'speaker');
      // On iOS, turning the speaker off leaves a connected Bluetooth device in
      // charge (iOS routes calls to it): only the preferred input moves a call
      // to the phone itself.
      if (route === 'earpiece' && chosen && Platform.OS === 'ios') {
        choose('EARPIECE');
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
