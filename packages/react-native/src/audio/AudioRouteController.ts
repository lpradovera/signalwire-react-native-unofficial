import { Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { BehaviorSubject } from 'rxjs';

import { logger } from '@signalwire/react';
import { assertPeerModule } from '../platform/peers';
import { audioDevices$, hasIosAudioRoutes, parseAudioDeviceStatus } from './nativeAudioRoutes';

import type { Observable, Subscription } from 'rxjs';
import type { AudioDeviceName, AudioDeviceStatus } from './nativeAudioRoutes';

export type AudioRoute = 'earpiece' | 'speaker' | 'bluetooth';

/** A route, and whether the user picked it or it is the call's default. */
interface RouteState {
  readonly route: AudioRoute;
  readonly chosen: boolean;
}

/** Off the speaker, with nothing chosen: iOS uses a connected headset or car, else the receiver. */
const DEFAULT_ROUTE: RouteState = { route: 'earpiece', chosen: false };

/** The route a device stands for. A wired headset reads as `'earpiece'`: off the speaker. */
const ROUTE_FOR_DEVICE: Record<AudioDeviceName, AudioRoute> = {
  EARPIECE: 'earpiece',
  SPEAKER_PHONE: 'speaker',
  WIRED_HEADSET: 'earpiece',
  BLUETOOTH: 'bluetooth'
};

/** incall-manager's name for each route the user can choose. */
const DEVICE_FOR_ROUTE: Record<AudioRoute, AudioDeviceName> = {
  earpiece: 'EARPIECE',
  speaker: 'SPEAKER_PHONE',
  bluetooth: 'BLUETOOTH'
};

/** One warning per process, not per bundle copy (see AUDIO_GLOBAL). */
const WARNED_GLOBAL = '__signalwireRNAudioRoutesWarned';

function warnNoIosRoutes(route: AudioRoute): void {
  const holder = globalThis as { [WARNED_GLOBAL]?: boolean };
  if (holder[WARNED_GLOBAL]) {
    return;
  }
  holder[WARNED_GLOBAL] = true;
  logger.warn(
    `Audio route "${route}" needs react-native-incall-manager with iOS audio routes; ` +
      'the installed one offers only speaker on/off on iOS. See "Audio routes on iOS" in the README.'
  );
}

/** The route state a refused choice goes back to. */
interface Snapshot {
  readonly route: AudioRoute;
  readonly chosen: boolean;
  readonly beforeSpeaker: RouteState;
}

/**
 * Owns the call's audio session and output routing, through
 * react-native-incall-manager, which owns the native session on both
 * platforms. This class never writes the session itself.
 *
 * On iOS, what it can do depends on incall-manager:
 *
 * - **With iOS audio routes** (the upstream change, or the patch in
 *   `docs/patches/`): every route can be chosen (`chooseAudioRoute`), and
 *   `route` mirrors what iOS reports, including a choice in the system route
 *   picker or CallKit, and a headset or car connecting or dropping.
 *   incall-manager keeps its own speaker setting in step with those changes,
 *   so nothing is written back from here.
 * - **Without** (released incall-manager through 4.3.0): speaker on and off
 *   only. `'bluetooth'` logs a warning once and is ignored, `'earpiece'` turns
 *   the speaker off (iOS still prefers a connected headset or car), and
 *   `route` is what was asked for.
 *
 * Android uses incall-manager's routes as before.
 */
export class AudioRouteController {
  private readonly _route$ = new BehaviorSubject<AudioRoute>('earpiece');
  /** Whether the current route is the user's choice, not the call's default. */
  private chosen = false;
  /** What turning the speaker off returns to. */
  private beforeSpeaker: RouteState = DEFAULT_ROUTE;
  private started = false;
  private destroyed = false;
  /** The device subscription while a call runs (iOS routes only). */
  private devices: Subscription | null = null;
  /** The device iOS last reported, and what is connected. */
  private device: AudioDeviceName | null = null;
  private available: readonly AudioDeviceName[] = [];
  /** Choices sent to incall-manager and not yet answered. */
  private choosing = 0;
  /** The latest report that arrived while a choice was in flight. */
  private deferred: AudioDeviceStatus | null = null;

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
    this.chosen = false;
    this.beforeSpeaker = DEFAULT_ROUTE;
    this.select(media === 'video' ? 'speaker' : 'earpiece', false);
    if (this.started && hasIosAudioRoutes()) {
      this.devices = audioDevices$.subscribe((status) => this.mirror(status));
    }
  }

  /** Ends the native audio session and resets to the earpiece. */
  stop(): void {
    this.devices?.unsubscribe();
    this.devices = null;
    this.device = null;
    this.available = [];
    this.deferred = null;
    try {
      if (this.started) {
        InCallManager.stop();
      }
    } catch (error) {
      logger.warn('Failed to stop the audio session:', error);
    }
    // Nothing native after stop(): incall-manager resets its own speaker
    // setting there, and its setForceSpeakerphoneOn has no started guard, so a
    // call now would reconfigure the torn-down session (for a video call:
    // voice chat mode, and the proximity sensor back on in an idle app).
    this.started = false;
    this.chosen = false;
    this.beforeSpeaker = DEFAULT_ROUTE;
    if (!this.destroyed) {
      this._route$.next('earpiece');
    }
  }

  /**
   * Requests an output route, as the user's choice. `'earpiece'` means the
   * phone's receiver, as on Android: with iOS routes it moves a call off a
   * connected headset or car. For a speaker on/off toggle use
   * {@link setSpeakerOn}, whose "off" returns to the call's own route instead.
   */
  setRoute(route: AudioRoute): void {
    if (route === this._route$.value && this.chosen) {
      return;
    }
    this.select(route, true);
  }

  /**
   * Turns the loudspeaker on, or off again. Off returns to the route the call
   * had before the speaker: the user's earlier choice, if that device is still
   * there, or else the default, where iOS plays a call through a connected
   * headset or car and otherwise the receiver. It never pins the call to the
   * receiver the way `setRoute('earpiece')` does.
   */
  setSpeakerOn(on: boolean): void {
    if (on) {
      if (this._route$.value !== 'speaker') {
        this.select('speaker', true);
      }
      return;
    }
    if (this._route$.value === 'speaker') {
      const back = this.beforeSpeaker;
      const gone = back.route === 'bluetooth' && this.devices !== null && !this.available.includes('BLUETOOTH');
      const { route, chosen } = gone ? DEFAULT_ROUTE : back;
      this.select(route, chosen);
    }
  }

  private select(route: AudioRoute, chosen: boolean): void {
    if (route === 'bluetooth' && Platform.OS === 'ios' && !hasIosAudioRoutes()) {
      warnNoIosRoutes(route);
      return;
    }
    const before: Snapshot = { route: this._route$.value, chosen: this.chosen, beforeSpeaker: this.beforeSpeaker };
    if (route === 'speaker' && before.route !== 'speaker') {
      this.beforeSpeaker = { route: before.route, chosen: this.chosen };
    }
    this.chosen = chosen;
    this._route$.next(route);
    this.applyRoute(route, chosen, before);
  }

  /**
   * Hands the route to incall-manager.
   *
   * @param chosen - The user asked for this route, as opposed to `start()` or
   *   speaker-off returning to the default. With iOS routes a choice goes
   *   through `chooseAudioRoute`; the default is just the speaker setting,
   *   which leaves iOS to pick a connected headset or car.
   */
  private applyRoute(route: AudioRoute, chosen: boolean, before: Snapshot): void {
    const choose = Platform.OS === 'ios' ? chosen && hasIosAudioRoutes() : route === 'bluetooth';
    if (!choose) {
      // Speaker on or off. Off (false) also takes a video call out of video
      // chat mode, which would keep it on the speaker. On iOS without routes
      // this is all there is, and "earpiece" can't leave a headset or car.
      try {
        InCallManager.setForceSpeakerphoneOn(route === 'speaker');
      } catch (error) {
        logger.warn(`Failed to apply audio route "${route}":`, error);
      }
      return;
    }
    // chooseAudioRoute returns a promise: a failure is a rejection, which a
    // try/catch never sees. A refused route (no such device) leaves
    // incall-manager's route as it was, so the controller goes back too.
    // Reports that arrive meanwhile predate the choice; they wait for its
    // answer, which carries the route iOS settled on.
    this.choosing += 1;
    Promise.resolve()
      .then(() => InCallManager.chooseAudioRoute(DEVICE_FOR_ROUTE[route]))
      .then(
        (raw: unknown) => {
          const answered = parseAudioDeviceStatus(raw);
          this.settleChoice(answered.selected !== null ? answered : null);
        },
        (error: unknown) => {
          logger.warn(`Failed to apply audio route "${route}":`, error);
          if (this.started && this._route$.value === route) {
            this.chosen = before.chosen;
            this.beforeSpeaker = before.beforeSpeaker;
            this._route$.next(before.route);
          }
          this.settleChoice(null);
        }
      );
  }

  /** A choice was answered: take on what iOS settled on, or what was reported meanwhile. */
  private settleChoice(answered: AudioDeviceStatus | null): void {
    this.choosing -= 1;
    if (this.choosing > 0) {
      return;
    }
    const latest = answered ?? this.deferred;
    this.deferred = null;
    if (latest && this.devices !== null) {
      this.mirror(latest);
    }
  }

  /**
   * Takes on the route iOS reports (iOS routes only): the call's starting
   * device, a choice in the system route picker or CallKit, a headset or car
   * connecting or dropping. incall-manager has already brought its speaker
   * setting in step, so nothing is written back.
   */
  private mirror(status: AudioDeviceStatus): void {
    this.available = status.available;
    if (this.choosing > 0) {
      this.deferred = status;
      return;
    }
    if (!this.started || status.selected === null) {
      return;
    }
    const device = status.selected;
    const wasChosen = this.chosen;
    if (device !== this.device) {
      // A different device than the one chosen has the call: nothing of ours
      // pins it any more (a wired headset replacing a receiver choice, say).
      if (this.device !== null && !(this.chosen && DEVICE_FOR_ROUTE[this._route$.value] === device)) {
        this.chosen = false;
      }
      this.device = device;
    }
    const route = ROUTE_FOR_DEVICE[device];
    const previous = this._route$.value;
    if (route === previous) {
      return;
    }
    if (route === 'speaker') {
      // Speaker off goes back to where the call was, chosen or not.
      this.beforeSpeaker = { route: previous, chosen: wasChosen };
    }
    this._route$.next(route);
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

/** Test seam — drops the singleton, and the once-per-process route warning. */
export function resetAudioRouteControllerForTesting(): void {
  const holder = globalThis as AudioHolder & { [WARNED_GLOBAL]?: boolean };
  holder[AUDIO_GLOBAL]?.destroy();
  delete holder[AUDIO_GLOBAL];
  delete holder[WARNED_GLOBAL];
}
