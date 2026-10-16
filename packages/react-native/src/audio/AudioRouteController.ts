import { NativeModules, Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { BehaviorSubject } from 'rxjs';

import { logger } from '@signalwire/react';
import { dropProcessGlobal, peekProcessGlobal, processGlobal } from '../platform/processGlobal';
import { assertPeerModule } from '../platform/peers';
import {
  androidAudioDeviceReports$,
  getAudioDeviceStatus,
  hasIosAudioRoutes,
  parseAudioDeviceStatus,
  sessionAudioDevices$
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

/**
 * How long an Android session waits for incall-manager's first device report
 * (its own start sends one) before applying a held choice anyway.
 */
const FIRST_REPORT_TIMEOUT_MS = 1000;

/**
 * incall-manager's starting route for the media when nothing else is
 * connected: video on the speaker, voice on the receiver. Shown until the
 * session's first status replaces it; with released incall-manager on iOS
 * nothing reports, so it stays (iOS may have put the call on a headset or car).
 */
function mediaDefault(media: 'audio' | 'video'): AudioRoute {
  return media === 'video' ? 'speaker' : 'earpiece';
}

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

/** Each warning once per process, not per bundle copy (see AUDIO_GLOBAL). */
const WARNED_GLOBAL = '__signalwireRNAudioRoutesWarned';

const WARNINGS = {
  noIosRoutes:
    'Audio route "bluetooth" needs react-native-incall-manager with iOS audio routes; ' +
    'the installed one offers only speaker on/off on iOS. See "Audio routes on iOS" in the README.',
  noSessionAndroid:
    'Audio routes on Android need the call\'s audio session: incall-manager refuses every route before its ' +
    'start(). The CallKit bridge starts it for its calls; otherwise call getAudioRouteController().start().',
  noSessionRoute:
    'Audio routes other than speaker on/off need the call\'s audio session (getAudioRouteController().start(), ' +
    'which the CallKit bridge calls for its calls); this one is ignored.'
} as const;

function warnOnce(key: keyof typeof WARNINGS): void {
  const warned = processGlobal(WARNED_GLOBAL, () => new Set<string>());
  if (warned.has(key)) {
    return;
  }
  warned.add(key);
  logger.warn(WARNINGS[key]);
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
  /** Whether incall-manager reports the devices: with iOS routes, and on Android. */
  readonly reports: boolean;
  /** The device subscription (iOS routes, Android). */
  devices: Subscription | null;
  /**
   * Whether the session's first status has come in: the read queued after
   * incall-manager's `start()` with iOS routes (the device feed drops the
   * reports before it, which describe the session before this call), or
   * Android's first report. Until then route choices are held, so they act on
   * the call's real route, not the media default; without reports it is set
   * at once.
   */
  ready: boolean;
  /** Android: applies held choices if no report comes. */
  readyTimer: ReturnType<typeof setTimeout> | null;
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
 *   or car), and `route` is what was asked for, starting from the media's
 *   default (`'speaker'` for video), which iOS doesn't report overriding.
 *
 * Android uses incall-manager's routes, and `route` follows its device
 * reports; a choice it can't make (Bluetooth or a headset with no such
 * device) goes back, as on iOS.
 *
 * Where incall-manager reports (iOS routes, Android), a route choice made
 * after `start()` but before the session's first status is held until it
 * comes in, so it acts on the call's real route rather than the media
 * default shown meanwhile.
 *
 * A choice made while a call that will start a session has not yet (a
 * speaker tap while an outbound CallKit call rings) is shown at once and
 * applied when it starts; if that call ends first, it is forgotten.
 *
 * With no session and none expected (an app without CallKit that hasn't
 * called {@link start}, or a call the CallKit bridge doesn't track), only the
 * speaker setting can be written, and only on iOS (incall-manager's
 * `setForceSpeakerphoneOn` works there without a session): speaker on and off
 * (`'earpiece'` is speaker off) are written and shown; `'headset'` and
 * `'bluetooth'` are ignored with a warning. On Android a never-started
 * incall-manager refuses every route, so nothing is written or shown, with a
 * warning. Call {@link start} and {@link stop} around a call for full routing.
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
  /** A call that will start a session is live; see {@link expectSession}. */
  private expecting = false;
  /**
   * Numbers the writes: a choice's refusal goes back only if no later choice
   * or write replaced it.
   */
  private writes = 0;
  /**
   * What a refused choice goes back to while choices are in flight: the
   * state before the first of them, which incall-manager had confirmed (or a
   * write had set), not another choice still waiting for its answer.
   */
  private unconfirmed: Snapshot | null = null;
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
   * @internal Called by the CallKit bridge whenever whether it tracks a live
   * call changes: such a call's session is started by the bridge, so while
   * one is live and no session runs, a route choice waits for it instead of
   * reaching incall-manager outside a call. When the last one ends with no
   * session (an outbound call nobody answered, a push that never got its
   * call), a held choice is forgotten and the route goes back to the
   * earpiece, as `stop()` does.
   */
  expectSession(expected: boolean): void {
    this.expecting = expected;
    if (expected || this.session || !this.early) {
      return;
    }
    this.early = null;
    this.chosen = false;
    this.beforeSpeaker = DEFAULT_ROUTE;
    if (!this.destroyed) {
      this._route$.next('earpiece');
    }
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
    const android = Platform.OS === 'android';
    const iosRoutes = Platform.OS === 'ios' && hasIosAudioRoutes();
    const session: Session = {
      media,
      iosRoutes,
      reports: iosRoutes || android,
      devices: null,
      ready: false,
      readyTimer: null,
      available: [],
      pending: 0,
      deferred: null
    };
    this.session = session;
    this.chosen = false;
    this.beforeSpeaker = DEFAULT_ROUTE;
    if (!this.early) {
      this._route$.next(mediaDefault(media));
    }
    if (iosRoutes) {
      // Its first value is a status read after incall-manager's start (or
      // null if that read failed), so it describes this call's session.
      session.devices = sessionAudioDevices$().subscribe((status) => this.report(session, status));
    } else if (android) {
      // incall-manager's start clears its devices and reports the one it
      // picks, so the first report after start() is this call's.
      session.devices = androidAudioDeviceReports$().subscribe((status) => this.report(session, status));
      session.readyTimer = setTimeout(() => this.report(session, null), FIRST_REPORT_TIMEOUT_MS);
    } else {
      this.begin(session, null);
    }
  }

  /** A status for the session (`null`: none came, or its read failed). */
  private report(session: Session, status: AudioDeviceStatus | null): void {
    if (this.session !== session) {
      return;
    }
    if (!session.ready) {
      this.begin(session, status);
    } else if (status) {
      this.mirror(session, status);
    }
  }

  /**
   * The session's first status: takes it on, then applies the choice held
   * for the session to the route it reports (or, with nothing reported, the
   * media default).
   */
  private begin(session: Session, status: AudioDeviceStatus | null): void {
    session.ready = true;
    if (session.readyTimer !== null) {
      clearTimeout(session.readyTimer);
      session.readyTimer = null;
    }
    const held = this.early;
    this.early = null;
    if (!held) {
      if (status) {
        this.mirror(session, status);
      }
      return;
    }
    if (status) {
      session.available = status.available;
    }
    const confirmed: Snapshot = {
      route: status?.selected ? ROUTE_FOR_DEVICE[status.selected] : mediaDefault(session.media),
      chosen: false,
      beforeSpeaker: DEFAULT_ROUTE
    };
    if (held.chosen) {
      this.select(held.route, true, undefined, confirmed);
    } else if (confirmed.route === 'speaker') {
      // Speaker off, held: it keeps a video call off the speaker.
      this.speakerOff(confirmed);
    } else {
      // Speaker off, held, and the call isn't on the speaker: nothing to write.
      this.chosen = false;
      this._route$.next(confirmed.route);
    }
  }

  /**
   * Ends the native audio session and resets to the earpiece. A choice held
   * for a call whose session hasn't started (see {@link expectSession}) is
   * kept for that call's `start()`, and stays shown; nothing else of the
   * ended session carries over.
   */
  stop(): void {
    const session = this.session;
    this.session = null;
    const held = this.expecting && !this.destroyed ? this.early : null;
    this.early = held;
    this.writes += 1;
    this.unconfirmed = null;
    session?.devices?.unsubscribe();
    if (session?.readyTimer) {
      clearTimeout(session.readyTimer);
    }
    try {
      if (session) {
        InCallManager.stop();
      }
    } catch (error) {
      logger.warn('Failed to stop the audio session:', error);
    }
    // Nothing native after stop(): incall-manager's setForceSpeakerphoneOn
    // has no started guard, so a call now would reconfigure the torn-down
    // session (for a video call: voice chat mode, and the proximity sensor
    // back on in an idle app). Its speaker setting needs no reset from here:
    // its start() resets it for the next call (4.3.0 and Android also reset
    // it in stop(); the iOS-routes change doesn't, and nothing reads it
    // between calls).
    this.chosen = held?.chosen ?? false;
    this.beforeSpeaker = DEFAULT_ROUTE;
    if (!this.destroyed) {
      this._route$.next(held?.route ?? 'earpiece');
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
    this.speakerOff();
  }

  /** Off the speaker, back to {@link beforeSpeaker} (or `base`'s) if that device is still there. */
  private speakerOff(base?: Snapshot): void {
    const session = this.session;
    const known = session !== null && session.reports && session.ready;
    const present = (device: AudioDeviceName): boolean => !known || session.available.includes(device);
    const back = base ? base.beforeSpeaker : this.beforeSpeaker;
    const target = present(DEVICE_FOR_ROUTE[back.route]) ? back : DEFAULT_ROUTE;
    // A device that turns out to be gone when asked for: speaker off anyway.
    this.select(target.route, target.chosen, () => this.select(DEFAULT_ROUTE.route, false), base);
  }

  /**
   * Shows a route and applies it, holds it for the session, or writes the
   * speaker setting outside one.
   *
   * @param base - The state to apply over instead of the shown one: a held
   *   choice is applied over the route the session's first status reported.
   */
  private select(route: AudioRoute, chosen: boolean, onRefused?: () => void, base?: Snapshot): void {
    const session = this.session;
    if (route === 'bluetooth' && Platform.OS === 'ios' && !(session?.iosRoutes ?? hasIosAudioRoutes())) {
      warnOnce('noIosRoutes');
      return;
    }
    const writesNow = !session && !this.expecting;
    if (writesNow && Platform.OS === 'android') {
      warnOnce('noSessionAndroid');
      return;
    }
    if (writesNow && (route === 'headset' || route === 'bluetooth')) {
      warnOnce('noSessionRoute');
      return;
    }
    const shown: Snapshot = base ?? {
      route: this._route$.value,
      chosen: this.chosen,
      beforeSpeaker: this.beforeSpeaker
    };
    const before = base ?? this.unconfirmed ?? shown;
    this.beforeSpeaker = shown.beforeSpeaker;
    if (route === 'speaker' && shown.route !== 'speaker') {
      this.beforeSpeaker = { route: shown.route, chosen: shown.chosen };
    }
    this.chosen = chosen;
    this._route$.next(route);
    if (session?.ready) {
      this.applyRoute(session, route, chosen, before, onRefused);
      return;
    }
    if (session || this.expecting) {
      // Not yet: shown now, applied when the session's first status is in.
      // Kept whether or not it is a choice: speaker-off (the default
      // route, not chosen) is still the user's last action, and start()
      // must not put a video call back on the speaker over it.
      this.early = { route, chosen };
      return;
    }
    // No session and none coming (iOS): speaker on/off, which incall-manager allows outside one.
    this.writeSpeaker(route, route === 'speaker');
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
    if (chosen && (session.iosRoutes || (android && (route === 'bluetooth' || route === 'headset')))) {
      this.choose(session, route, before, onRefused);
      return;
    }
    const flag = speakerFlag(session, route, chosen);
    // A write replaces every choice still in flight: their refusals no
    // longer go back, and what it sets is the state to go back to.
    this.writes += 1;
    this.unconfirmed = null;
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
    this.writes += 1;
    const write = this.writes;
    this.unconfirmed = before;
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
            this.refuse(session, write, before, onRefused);
          } else {
            this.confirm(write);
          }
          this.settle(session, null);
          return;
        }
        this.confirm(write);
        this.settle(session, answered.selected !== null ? answered : null);
      },
      (error: unknown) => {
        logger.warn(`Failed to apply audio route "${route}":`, error);
        this.refuse(session, write, before, onRefused);
        this.settle(session, null);
      }
    );
  }

  /** The latest choice was taken: nothing in flight to go back from. */
  private confirm(write: number): void {
    if (write === this.writes) {
      this.unconfirmed = null;
    }
  }

  /**
   * Puts the route state back the way it was before a refused choice, if no
   * later choice or write replaced it (that one's own answer decides).
   */
  private refuse(session: Session, write: number, before: Snapshot, onRefused: (() => void) | undefined): void {
    if (this.session !== session || write !== this.writes) {
      return;
    }
    this.unconfirmed = null;
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
    if (latest) {
      this.mirror(session, latest);
    }
  }

  /**
   * Takes on the route incall-manager reports (iOS routes, Android): the
   * call's starting device, a choice in the system route picker or CallKit,
   * a headset or car connecting or dropping. incall-manager has already
   * brought its speaker setting in step, so nothing is written back. A
   * reported route other than the one shown ends the user's choice.
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

/**
 * The `setForceSpeakerphoneOn` flag for a speaker write: on (`true`), off
 * (`false`, incall-manager's "speaker off": the receiver on Android, and on
 * iOS voice chat mode for a video call), or incall-manager's default for the
 * media (`null`).
 *
 * Off back to a headset or car the speaker replaced (not a choice; a choice
 * goes through `chooseAudioRoute`) is the default, which picks it: on iOS it
 * keeps a video call in video chat mode there, and on Android `false` would
 * make the receiver the user's selection, which Android prefers over the
 * headset. Off back to the receiver is the default too for an Android voice
 * call (a headset or car if one is connected, else the receiver); a video
 * call's default is the speaker, so it gets `false`, as does every call with
 * iOS routes (the receiver) and without reports (released incall-manager on
 * iOS: speaker on/off only).
 */
function speakerFlag(session: Session, route: AudioRoute, chosen: boolean): boolean | null {
  if (route === 'speaker') {
    return true;
  }
  if (!session.reports) {
    return false;
  }
  if (route === 'headset' || route === 'bluetooth') {
    return null;
  }
  return Platform.OS === 'android' && !chosen && session.media === 'audio' ? null : false;
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
