import { NativeModules, Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { BehaviorSubject } from 'rxjs';

import { logger } from '@signalwire/react';
import { dropProcessGlobal, peekProcessGlobal, processGlobal } from '../platform/processGlobal';
import { assertPeerModule } from '../platform/peers';
import {
  audioDevices$,
  getAudioDeviceStatus,
  hasIosAudioRoutes,
  parseAudioDeviceStatus
} from './nativeAudioRoutes';

import type { Observable, Subscription } from 'rxjs';
import type { AudioDeviceName, AudioDeviceStatus } from './nativeAudioRoutes';

/**
 * Where a call's audio plays: one route per incall-manager device. A wired or
 * USB-C headset is `'headset'`; a Bluetooth headset or car is `'bluetooth'`.
 */
export type AudioRoute = 'earpiece' | 'speaker' | 'headset' | 'bluetooth';

/** A route, and whether the user picked it or it is the call's default. */
interface RouteState {
  readonly route: AudioRoute;
  readonly chosen: boolean;
}

/** Off the speaker, with nothing chosen: iOS uses a connected headset or car, else the receiver. */
const DEFAULT_ROUTE: RouteState = { route: 'earpiece', chosen: false };

/** The route each incall-manager device is. incall-manager reports USB audio as WIRED_HEADSET and a car as BLUETOOTH. */
const ROUTE_FOR_DEVICE: Record<AudioDeviceName, AudioRoute> = {
  EARPIECE: 'earpiece',
  SPEAKER_PHONE: 'speaker',
  WIRED_HEADSET: 'headset',
  BLUETOOTH: 'bluetooth'
};

/** incall-manager's name for each route. */
const DEVICE_FOR_ROUTE: Record<AudioRoute, AudioDeviceName> = {
  earpiece: 'EARPIECE',
  speaker: 'SPEAKER_PHONE',
  headset: 'WIRED_HEADSET',
  bluetooth: 'BLUETOOTH'
};

/** One warning per process, not per bundle copy (see AUDIO_GLOBAL). */
const WARNED_GLOBAL = '__signalwireRNAudioRoutesWarned';

function warnNoIosRoutes(): void {
  const warned = processGlobal(WARNED_GLOBAL, () => ({ done: false }));
  if (warned.done) {
    return;
  }
  warned.done = true;
  logger.warn(
    'Audio route "bluetooth" needs react-native-incall-manager with iOS audio routes; ' +
      'the installed one offers only speaker on/off on iOS. See "Audio routes on iOS" in the README.'
  );
}

/** The route state a refused choice goes back to. */
interface Snapshot extends RouteState {
  readonly beforeSpeaker: RouteState;
}

/**
 * One call's audio session, from a successful `start()` to `stop()`. Every
 * answer, refusal and report checks that its session is still the current
 * one, so nothing from an ended call reaches the next.
 */
interface Session {
  readonly media: 'audio' | 'video';
  /** Whether incall-manager has iOS routes, read once per call. */
  readonly iosRoutes: boolean;
  /** The device subscription (iOS routes only). */
  devices: Subscription | null;
  /**
   * Whether the status read queued after incall-manager's `start()` has
   * come back. Reports before it describe the session before this call (the
   * previous call's last device, or an idle read), so they are ignored.
   */
  ready: boolean;
  /** What is connected, as last reported or answered. */
  available: readonly AudioDeviceName[];
  /** Writes sent to incall-manager whose settled status hasn't come back. */
  pending: number;
  /** The latest report that arrived while a write was pending. */
  deferred: AudioDeviceStatus | null;
}

/**
 * Owns the call's audio session and output routing, through
 * react-native-incall-manager. This class never writes the native session
 * itself; incall-manager writes it, and so do callkeep (its category and
 * mode on every CallKit activation) and WebRTC (its own configuration).
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
 *   only. `'bluetooth'` logs a warning once and is ignored, `'earpiece'` and
 *   `'headset'` turn the speaker off (iOS still prefers a connected headset
 *   or car), and `route` is what was asked for.
 *
 * Android uses incall-manager's routes; a choice it can't make (Bluetooth
 * or a headset with no such device) goes back, as on iOS.
 *
 * A choice made before the call's session starts (a speaker tap while an
 * outbound call rings, with CallKit driving the session) is shown at once and
 * applied when it starts. Nothing native is written outside a session.
 */
export class AudioRouteController {
  private readonly _route$ = new BehaviorSubject<AudioRoute>('earpiece');
  /** Whether the current route is the user's choice, not the call's default. */
  private chosen = false;
  /** What turning the speaker off returns to. */
  private beforeSpeaker: RouteState = DEFAULT_ROUTE;
  private session: Session | null = null;
  /**
   * The user's last route action before start(), applied when it runs: a
   * choice, or speaker-off back to the default (not a choice, but it keeps a
   * video call off the speaker).
   */
  private early: RouteState | null = null;
  /** Calls start and stop the session (CallKit is set up); see {@link holdChoicesUntilStart}. */
  private holdsUntilStart = false;
  private destroyed = false;

  constructor() {
    // The native module, not the JS wrapper: the wrapper is a class instance
    // whose methods exist whether or not the native side is linked.
    assertPeerModule(
      (NativeModules as Record<string, object | undefined> | undefined)?.InCallManager,
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

  /**
   * @internal Called by the CallKit bridge's `setup()`: from then on each
   * call's session is started and stopped for it, so a route chosen before a
   * session runs waits for it instead of reaching incall-manager outside a
   * call.
   */
  holdChoicesUntilStart(): void {
    this.holdsUntilStart = true;
  }

  /**
   * Begins the native audio session. incall-manager's own start puts a video
   * call on the speaker when nothing else is connected and a voice call on
   * the receiver, or a connected headset or car; nothing is forced over that.
   */
  start(media: 'audio' | 'video'): void {
    // Idempotent: an answered inbound call starts audio on the native answer
    // and again when it reaches `connected`. Restarting would re-run
    // InCallManager and force the route back to its default, discarding a
    // speaker toggle the user had already made.
    if (this.session) {
      return;
    }
    try {
      InCallManager.start({ media });
      logger.debug(`Audio session started (${media})`);
    } catch (error) {
      logger.warn('Failed to start the audio session:', error);
      return;
    }
    const session: Session = {
      media,
      iosRoutes: Platform.OS === 'ios' && hasIosAudioRoutes(),
      devices: null,
      ready: false,
      available: [],
      pending: 0,
      deferred: null
    };
    this.session = session;
    const early = this.early;
    this.early = null;
    this.chosen = false;
    this.beforeSpeaker = DEFAULT_ROUTE;
    if (!early) {
      this._route$.next(media === 'video' ? 'speaker' : 'earpiece');
    }
    if (session.iosRoutes) {
      session.devices = audioDevices$.subscribe((status) => this.mirror(session, status));
      getAudioDeviceStatus().then(
        (status) => {
          if (this.session === session && status) {
            session.ready = true;
            this.mirror(session, status);
          }
        },
        (error: unknown) => {
          logger.warn('Failed to read the audio devices:', error);
          session.ready = true;
        }
      );
    }
    if (early) {
      this.select(early.route, early.chosen);
    }
  }

  /** Ends the native audio session and resets to the earpiece. */
  stop(): void {
    const session = this.session;
    this.session = null;
    this.early = null;
    session?.devices?.unsubscribe();
    try {
      if (session) {
        InCallManager.stop();
      }
    } catch (error) {
      logger.warn('Failed to stop the audio session:', error);
    }
    // Nothing native after stop(): incall-manager resets its own speaker
    // setting there, and its setForceSpeakerphoneOn has no started guard, so a
    // call now would reconfigure the torn-down session (for a video call:
    // voice chat mode, and the proximity sensor back on in an idle app).
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
    if (this._route$.value !== 'speaker') {
      return;
    }
    const session = this.session;
    const known = session !== null && (session.iosRoutes || Platform.OS === 'android');
    const present = (device: AudioDeviceName): boolean => !known || session.available.includes(device);
    const back = this.beforeSpeaker;
    const target = present(DEVICE_FOR_ROUTE[back.route]) ? back : DEFAULT_ROUTE;
    // A device that turns out to be gone when asked for: speaker off anyway.
    this.select(target.route, target.chosen, () => this.select(DEFAULT_ROUTE.route, false));
  }

  private select(route: AudioRoute, chosen: boolean, onRefused?: () => void): void {
    const session = this.session;
    if (route === 'bluetooth' && Platform.OS === 'ios' && !(session?.iosRoutes ?? hasIosAudioRoutes())) {
      warnNoIosRoutes();
      return;
    }
    const before: Snapshot = { route: this._route$.value, chosen: this.chosen, beforeSpeaker: this.beforeSpeaker };
    if (route === 'speaker' && before.route !== 'speaker') {
      this.beforeSpeaker = { route: before.route, chosen: this.chosen };
    }
    this.chosen = chosen;
    this._route$.next(route);
    if (session) {
      this.applyRoute(session, route, chosen, before, onRefused);
      return;
    }
    if (this.holdsUntilStart) {
      // No session yet: shown now, applied when the call's session starts.
      // Kept whether or not it is a choice: speaker-off (the default
      // route, not chosen) is still the user's last action, and start()
      // must not put a video call back on the speaker over it.
      this.early = { route, chosen };
      return;
    }
    // An app that starts no session (no CallKit): speaker on/off, as incall-manager allows outside one.
    if (route !== 'bluetooth') {
      this.writeSpeaker(route, route === 'speaker');
    }
  }

  /**
   * Hands the route to incall-manager.
   *
   * @param chosen - The user asked for this route, as opposed to speaker-off
   *   returning to the default. With iOS routes a choice goes through
   *   `chooseAudioRoute`; the default is just the speaker setting, which
   *   leaves iOS to pick a connected headset or car.
   */
  private applyRoute(
    session: Session,
    route: AudioRoute,
    chosen: boolean,
    before: Snapshot,
    onRefused: (() => void) | undefined
  ): void {
    const android = Platform.OS === 'android';
    if (session.iosRoutes ? chosen : android && (route === 'bluetooth' || route === 'headset')) {
      this.choose(session, route, before, onRefused);
      return;
    }
    // Speaker on, or off. With iOS routes, off goes back to a headset or car
    // the speaker had replaced at incall-manager's default (null), which
    // keeps a video call in video chat mode there; a call that was on the
    // receiver, or any call without iOS routes, gets "speaker off" (false),
    // which also takes a video call out of video chat mode, so it doesn't
    // fall back to the speaker.
    const toDevice = session.iosRoutes && (route === 'headset' || route === 'bluetooth');
    const flag = route === 'speaker' ? true : toDevice ? null : false;
    if (!session.iosRoutes) {
      this.writeSpeaker(route, flag);
      return;
    }
    // incall-manager reports a route change only when its status changes, so
    // a write that moves nothing (the call stays on AirPods) gets no report.
    // Read what it settled on instead, through the same gate as a choice.
    session.pending += 1;
    this.writeSpeaker(route, flag);
    getAudioDeviceStatus().then(
      (status) => this.settle(session, status),
      (error: unknown) => {
        logger.warn('Failed to read the audio devices:', error);
        this.settle(session, null);
      }
    );
  }

  private writeSpeaker(route: AudioRoute, flag: boolean | null): void {
    try {
      InCallManager.setForceSpeakerphoneOn(flag as boolean);
    } catch (error) {
      logger.warn(`Failed to apply audio route "${route}":`, error);
    }
  }

  /**
   * Sends a choice through `chooseAudioRoute`. A refused route (no such
   * device) leaves incall-manager's route as it was, so the controller goes
   * back too. Reports that arrive meanwhile predate the choice; they wait for
   * its answer, which carries the route incall-manager settled on.
   */
  private choose(session: Session, route: AudioRoute, before: Snapshot, onRefused: (() => void) | undefined): void {
    const device = DEVICE_FOR_ROUTE[route];
    session.pending += 1;
    // Called now, in order with every other native call; a synchronous throw
    // becomes a rejection like any refusal.
    new Promise<unknown>((resolve) => resolve(InCallManager.chooseAudioRoute(device))).then(
      (raw: unknown) => {
        const answered = parseAudioDeviceStatus(raw);
        // Android's chooseAudioRoute never rejects: a device it can't select
        // is logged and the unchanged status comes back.
        if (Platform.OS === 'android') {
          if (this.session === session) {
            session.available = answered.available;
          }
          if (!answered.available.includes(device)) {
            logger.warn(`Failed to apply audio route "${route}": no such device`);
            this.refuse(session, route, before, onRefused);
          }
          this.settle(session, null);
          return;
        }
        this.settle(session, answered.selected !== null ? answered : null);
      },
      (error: unknown) => {
        logger.warn(`Failed to apply audio route "${route}":`, error);
        this.refuse(session, route, before, onRefused);
        this.settle(session, null);
      }
    );
  }

  /** Puts the route state back the way it was before a refused choice, if nothing replaced it. */
  private refuse(session: Session, route: AudioRoute, before: Snapshot, onRefused: (() => void) | undefined): void {
    if (this.session !== session || this._route$.value !== route) {
      return;
    }
    this.chosen = before.chosen;
    this.beforeSpeaker = before.beforeSpeaker;
    this._route$.next(before.route);
    onRefused?.();
  }

  /** A write was answered: take on what iOS settled on, or what was reported meanwhile. */
  private settle(session: Session, answered: AudioDeviceStatus | null): void {
    if (this.session !== session) {
      return;
    }
    session.pending -= 1;
    if (session.pending > 0) {
      return;
    }
    const latest = answered ?? session.deferred;
    session.deferred = null;
    if (latest && session.devices !== null) {
      this.mirror(session, latest);
    }
  }

  /**
   * Takes on the route iOS reports (iOS routes only): the call's starting
   * device, a choice in the system route picker or CallKit, a headset or car
   * connecting or dropping. incall-manager has already brought its speaker
   * setting in step, so nothing is written back. A reported route other than
   * the one shown ends the user's choice.
   */
  private mirror(session: Session, status: AudioDeviceStatus): void {
    if (this.session !== session || !session.ready) {
      return;
    }
    session.available = status.available;
    if (session.pending > 0) {
      session.deferred = status;
      return;
    }
    if (status.selected === null) {
      return;
    }
    const route = ROUTE_FOR_DEVICE[status.selected];
    const previous = this._route$.value;
    if (route === previous) {
      return;
    }
    if (route === 'speaker') {
      // Speaker off goes back to where the call was, chosen or not.
      this.beforeSpeaker = { route: previous, chosen: this.chosen };
    }
    // Something else has the call (a wired headset replacing a receiver
    // choice, say): nothing of ours pins it any more.
    this.chosen = false;
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

/** The process-wide audio route controller. One audio session exists per app. */
export function getAudioRouteController(): AudioRouteController {
  return processGlobal(AUDIO_GLOBAL, () => new AudioRouteController());
}

/** Test seam — drops the singleton, and the once-per-process route warning. */
export function resetAudioRouteControllerForTesting(): void {
  peekProcessGlobal<AudioRouteController>(AUDIO_GLOBAL)?.destroy();
  dropProcessGlobal(AUDIO_GLOBAL);
  dropProcessGlobal(WARNED_GLOBAL);
}
