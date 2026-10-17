import { AppState, NativeModules, PermissionsAndroid, Platform } from 'react-native';
import {
  BehaviorSubject,
  concat,
  defer,
  distinctUntilChanged,
  EMPTY,
  filter,
  finalize,
  firstValueFrom,
  from,
  map,
  of,
  Subject,
  switchMap,
  take,
  takeUntil,
  timeout
} from 'rxjs';

import { getAudioRouteController } from '../audio/AudioRouteController';
import type { AudioRouteController } from '../audio/AudioRouteController';
import { getCallHoldState, logger } from '@signalwire/react';
import { CallInProgressError } from '../errors';
import { assertPeerModule } from '../platform/peers';
import { dropProcessGlobal, peekProcessGlobal, processGlobal } from '../platform/processGlobal';
import { forgetPendingVoipCall, getPendingVoipCalls } from '../push/voipToken';
import { CALLKIT_BRIDGE_KEY } from './bridgeKey';
import { getCallKeep, requireCallKeep } from './callkeepModule';
import { WebRTCAudioSessionLink } from './webrtcAudioSession';
import { CallRegistry, DEFAULT_FUSION_TIMEOUT_MS, INBOUND_ANSWER } from './CallRegistry';

import type { PendingCall } from '../push/voipToken';
import type { CallKeep } from './callkeepModule';
import type { CallWaitingMode } from './callWaitingMode';
import type { CallEndReason, CallEntry, CallRegistryHost, PushPayload } from './types';
import type { OtherCalls } from '@signalwire/react';

/**
 * callkeep's module: `@signalwire/react-native-callkeep`, else stock
 * `react-native-callkeep` (see `callkeepModule`). Undefined when the app has
 * neither: setup() then throws MissingPeerDependencyError before any call
 * reaches it, and the constructor registers no listeners.
 */
const RNCallKeep = getCallKeep()?.module as CallKeep;

/** The `didDisplayIncomingCall` payload, which callkeep types loosely. */
interface DisplayEvent {
  /** Set when CallKit refused the call: Focus, the block list, no entitlement. */
  error?: string;
  errorCode?: string;
  callUUID: string;
  handle: string;
  localizedCallerName: string;
  fromPushKit: string;
  payload?: object;
}

/** One entry of callkeep's `didLoadWithEvents` replay array. */
interface LoadedEvent {
  name: string;
  data: unknown;
}
import type { Call, SignalWire } from '@signalwire/js';
import type { Subscription } from 'rxjs';
import type { Observable } from 'rxjs';

/** The `didReceiveStartCallAction` payload, which callkeep types loosely. */
interface StartCallEvent {
  handle?: string;
  callUUID?: string;
  name?: string;
  video?: boolean;
}

/**
 * A call the user asked to place from outside the app: by tapping one of its
 * calls in the Phone app's Recents, or by asking Siri to call back. Dial
 * `handle` (the destination the earlier call was placed to or came from).
 */
export interface StartCallRequest {
  /** The destination to dial. */
  readonly handle: string;
  /** The name Recents or Siri showed, when callkeep reports one. */
  readonly displayName: string | undefined;
  /** Whether a video call was asked for. */
  readonly video: boolean;
}

/** How long a call-back waits for a subscriber before it is dropped. */
const START_REQUEST_TTL_MS = 60_000;

const TICK_INTERVAL_MS = 2000;
const AUDIO_SESSION_TIMEOUT_MS = 3000;
/**
 * How long an ended owner's session waits for a ringing call to be answered
 * before it is stopped. CallKit's End & Accept delivers the ended call's
 * endCall and the accepted call's answerCall back to back, as one
 * transaction; a call still only ringing after this is not being accepted
 * with it.
 */
const HANDOVER_GRACE_MS = 1000;
const HANDLE_TYPE = 'generic';
/** A handle callkeep's updateDisplay can re-send as a phone number unchanged in meaning. */
const PHONE_NUMBER = /^\+?[0-9]+$/;

/**
 * The package's own Android module (android/): the incoming-call notification
 * a self-managed ConnectionService must post. Absent until the app is rebuilt
 * with the package autolinked.
 */
interface IncomingCallModule {
  show(
    uuid: string,
    handle: string,
    name: string,
    hasVideo: boolean,
    channelName: string
  ): Promise<boolean>;
  cancel(uuid: string): void;
  /** No call is left: the app stops showing over the lock screen. */
  release(): void;
}

function incomingCallModule(): IncomingCallModule | undefined {
  const modules = NativeModules as Record<string, IncomingCallModule | undefined> | undefined;
  return modules?.SignalWireIncomingCall;
}

/** callkeep's `showIncomingCallUi` / `createIncomingConnectionFailed` payload (Android). */
interface ConnectionEvent {
  callUUID: string;
  handle?: string;
  name?: string;
  hasVideo?: string;
}

/**
 * callkeep's `didFailCallAction` payload (the SignalWire fork): CallKit refused
 * a transaction (iOS), or Telecom refused an outgoing connection (Android,
 * `startCall` only, errorCode `ConnectionRefused`).
 */
interface FailedActionEvent {
  callUUID?: string;
  action?: string;
  errorCode?: string;
  error?: string;
}

/** Refused actions after which the native side has no call: start, answer and end. */
const CALL_ACTIONS = new Set(['startCall', 'answerCall', 'endCall']);

/**
 * Runtime permissions the call needs on Android, for this API level.
 *
 * callkeep requests none of them with `selfManaged: true` (its `_setupAndroid`
 * returns first), so this package does. READ_PHONE_NUMBERS above all:
 * callkeep's `VoiceConnectionService.createConnection` calls
 * `TelecomManager.getPhoneAccount`, and ungranted, the first incoming or
 * outgoing call kills the app:
 *
 *   FATAL EXCEPTION: main
 *   SecurityException: Neither user nor current process has
 *   android.permission.READ_PHONE_NUMBERS.
 *     at VoiceConnectionService.createConnection
 *
 * RECORD_AUDIO also gates callkeep's own `startCall`, which ignores the call
 * without it; POST_NOTIFICATIONS (13+) lets the incoming-call and ongoing-call
 * notifications show; BLUETOOTH_CONNECT (12+) lets incall-manager see a headset.
 *
 * Not CAMERA: react-native-webrtc's getUserMedia asks for it when a call first
 * sends video, so an app that never does is never asked.
 */
function androidCallPermissions(): string[] {
  const api = Number(Platform.Version);
  return [
    'android.permission.READ_PHONE_NUMBERS',
    'android.permission.RECORD_AUDIO',
    ...(api >= 33 ? ['android.permission.POST_NOTIFICATIONS'] : []),
    ...(api >= 31 ? ['android.permission.BLUETOOTH_CONNECT'] : [])
  ];
}

/** Call statuses after which the native entry must be torn down. */
// 'ended' is what the SDK actually reports — the wire shows call_state
// created -> answered -> ending -> ended. Without it a remote hangup never
// reached reportRemoteEnded, so the native entry outlived the call and the
// user had to end it by hand.
//
// 'disconnecting' is the app's own hangup(): the SDK reaches 'destroyed'
// only once the bye settles, up to its RPC timeout on a bad network, and
// until then the CallKit call, the entry and the audio session stayed up.
//
// 'disconnected' is NOT here. The SDK merges the peer connection's state
// into status$, and 'disconnected' is what an ICE blip (Wi-Fi to cellular)
// produces before the SDK's recovery restores the call. Ending the native
// call there left a connected SDK call with no CallKit call and no audio.
// A call that does not recover ends 'failed' (all recovery attempts
// exhausted), and a remote bye always reaches 'destroyed'.
const TERMINAL_STATUSES = new Set<string>(['ended', 'disconnecting', 'destroyed', 'failed']);


export type { CallWaitingMode } from './callWaitingMode';

export interface CallKitSetupOptions {
  appName: string;
  /** See {@link CallWaitingMode}. Default `'full'`. */
  callWaiting?: CallWaitingMode;
  /**
   * End the calls when the app's activity is destroyed (Android: Back on the
   * root screen, or the app swiped away). Default `false`: the call goes on,
   * the ongoing-call notification brings the app back, and
   * `SignalWireProvider` keeps the client and its calls while the app is
   * unmounted (`keepCallsOnUnmount`). The provider does the same on iOS.
   * `true` is the old behaviour: Back ends the call, and an unmounted
   * provider hangs its calls up.
   */
  endCallsOnHostDestroy?: boolean;
  imageName?: string;
  ringtoneSound?: string;
  /** Whether the native UI offers a video button. Default `false`. */
  supportsVideo?: boolean;
  /** Channel of the ongoing-call (foreground service) notification. */
  androidChannelId?: string;
  androidChannelName?: string;
  /**
   * iOS: list this app's calls in the Phone app's Recents, from where the
   * user can call back (see `startCallRequested$`). Default `true`.
   */
  includesCallsInRecents?: boolean;
  /** Name of the channel incoming calls ring on. Default `'Incoming calls'`. */
  androidIncomingChannelName?: string;
  /**
   * `mipmap` resource for the ongoing-call notification's small icon.
   * Default `'ic_launcher'`, the app icon Expo and the React Native template
   * generate. Android refuses a notification without one.
   */
  androidNotificationIcon?: string;
  /**
   * How long a push entry waits for its SDK call, in ms: for a bridge push,
   * how long it rings. Applies to pushes reported after `setup()`. Default
   * 45000.
   */
  fusionTimeoutMs?: number;
}

/**
 * Connects {@link CallRegistry} to callkeep (`@signalwire/react-native-callkeep`,
 * or stock `react-native-callkeep`).
 *
 * The only file in the package that calls callkeep (`callkeepModule` loads
 * it). Lives at module scope as a singleton because a VoIP push can wake the
 * app before React mounts.
 */
export class CallKeepBridge {
  readonly registry: CallRegistry;

  private readonly destroyed$ = new Subject<void>();
  private supportsVideo = false;
  private isSetup = false;
  /** The one setup() in flight or done; see {@link setup}. */
  private setupPromise: Promise<void> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Whether CallKit has the audio session active, from its activate and
   * deactivate events. Kept as state, not as a one-shot gate: for an outbound
   * call CallKit activates the session when the start-call action is
   * fulfilled, before the call connects, so a gate created at `connected`
   * would wait for an event that has already fired.
   */
  private readonly audioSessionActive$ = new BehaviorSubject(false);
  /** Starts and stops WebRTC's audio unit with CallKit's activations (iOS). */
  private readonly webrtcAudio = new WebRTCAudioSessionLink();
  /**
   * What removes each of the bridge's callkeep handlers (see {@link listen}).
   * destroy() removes these, and only these: callkeep's
   * removeEventListener(type) with no handler removes every handler of that
   * type in the process (on 4.3.0-4.3.8, whichever was added last), the app's
   * own included.
   */
  private readonly nativeListeners: Array<{ remove(): void }> = [];
  /**
   * Answers and ends for a uuid the registry doesn't know yet: replayed ones
   * (the replay can reach JS before setup() adopts the cached launch push; see
   * handleLoadedEvents) and live ones that arrive while setup() is still
   * fetching that push. They are applied when the entry is adopted. One whose
   * entry never comes (the cache keeps only the last of several cold-start
   * pushes) expires after the fusion timeout, and an answered call is then
   * ended natively, as an unanswered push would be.
   */
  private readonly heldActions = new Map<
    string,
    { actions: Array<'answer' | 'end'>; deadline: number }
  >();
  /**
   * True until setup() has fetched the cached launch push. The listeners are
   * registered in the constructor, so an answer or end for a call the
   * registry doesn't know yet can arrive before setup() runs; it is held
   * (see heldActions) rather than applied to nothing.
   */
  private adoptingLaunchPush = true;
  private readonly holdTimeoutMs: number;
  /** The clients whose inbound calls are mirrored; see {@link bindClient}. */
  private readonly boundClients = new Map<SignalWire, { subscription: Subscription; binders: number }>();
  /** Whether the audio controller was last told a live call will start its session. */
  private expectingAudio = false;
  /** Entry awaiting a bridge dial; see {@link beginBridgeDial}. */
  private pendingBridgeUuid: string | null = null;
  /** Calls whose incoming-call notification is up. */
  private readonly notified = new Set<string>();
  /** A notification let the app show over the lock screen; released with the last call. */
  private lockScreenHeld = false;
  /** Calls CallKit refused to show or Telecom refused to connect; see handleDisplayRefused and handleConnectionFailed. */
  private readonly refused = new Set<string>();
  private incomingChannelName = 'Incoming calls';
  private permissionsWait: { remove(): void } | null = null;
  /**
   * SDK inbound calls. The registry answers every one of them with
   * INBOUND_ANSWER (audio-only today; an in-app answer included, since that
   * is routed through CallKit), so their media is that answer's, whatever
   * their offer carried. See {@link mediaFor}.
   */
  private readonly inboundCalls = new WeakSet<Call>();
  /** The call whose native end is being handled; see {@link reportEnded}. */
  private endingNatively: string | null = null;
  /**
   * The call the audio session was started for. There is one session per
   * app, so only this call may stop it, and it is released when this call
   * ends, by whichever path. See {@link startAudio}.
   */
  private audioUuid: string | null = null;
  /** The media the session was started with; see {@link startAudio}. */
  private audioMedia: 'audio' | 'video' | null = null;
  /**
   * Calls that are taking the session: answered, placed by the user, or
   * connected. A call that only rings is not, so it can't keep an ended
   * owner's session up for itself.
   */
  private readonly audioClaims = new Set<string>();
  /** Stops an ended owner's session if no call takes it; see {@link releaseAudioIfOwnerEnded}. */
  private handoverTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _startCallRequested$ = new Subject<StartCallRequest>();
  /** Call-backs that arrived before anyone subscribed (a cold start from Recents). */
  private heldStartRequests: Array<{ request: StartCallRequest; at: number }> = [];
  /**
   * A CallKit mute set before the entry's call has a self participant (a
   * bridge call still being placed, a call not yet joined), applied when the
   * participant appears. See {@link handleSetMuted}.
   */
  private readonly pendingMute = new Map<string, boolean>();
  private _callWaiting: CallWaitingMode = 'full';
  private endCallsOnHostDestroy = false;
  /**
   * The hold state last asked for, per entry, by the native UI or the app.
   * The SDK's own state changes only when its request resolves, so this is
   * what keeps a hold asked for twice (CallKit's Hold & Accept, then its
   * answer) from being requested twice.
   */
  private readonly wantHeld = new Map<string, boolean>();

  constructor(options: { fusionTimeoutMs?: number } = {}) {
    this.holdTimeoutMs = options.fusionTimeoutMs ?? DEFAULT_FUSION_TIMEOUT_MS;
    const host: CallRegistryHost = {
      // The registry writes the entry before it calls the host, so the call (if
      // there is one yet) is there to read its media from.
      displayIncomingCall: (uuid, handle, displayName) =>
        RNCallKeep.displayIncomingCall(uuid, handle, displayName, HANDLE_TYPE, this.reportsVideo(uuid)),
      startOutgoingCall: (uuid, handle, displayName) =>
        RNCallKeep.startCall(uuid, handle, displayName, HANDLE_TYPE, this.reportsVideo(uuid)),
      // callkeep's reportConnectedOutgoingCallWithUUID is iOS-only, a no-op on
      // Android. There a connection stays RINGING or DIALING in Telecom until
      // it is set active (no audio focus, no "ongoing call" anywhere, and
      // Android 16 disconnects it after about two minutes).
      reportOutgoingConnected: (uuid) =>
        Platform.OS === 'android'
          ? RNCallKeep.setCurrentCallActive(uuid)
          : RNCallKeep.reportConnectedOutgoingCallWithUUID(uuid),
      reportCallEnded: (uuid, reason) => this.reportEnded(uuid, reason),
      generateUuid: () => generateUuid(),
      now: () => Date.now()
    };

    this.registry = new CallRegistry({
      host,
      fusionTimeoutMs: options.fusionTimeoutMs,
      // 'full', the default, until setup() says otherwise: a call, and one
      // waiting or on hold.
      callLimit: callLimitFor('full')
    });

    // A call can end in the native UI, from the SDK, or in the registry
    // itself: the app's endCall (a failed bridge dial), or tick() expiring an
    // answered push. CallKit answers none of the registry's own reports with
    // an endCall action, so watching the entries is the one place that sees
    // every end. Without it a session started for such a call stayed up in the
    // idle app, and the next call's start was ignored.
    this.registry.entries$
      .pipe(takeUntil(this.destroyed$))
      .subscribe(() => {
        this.forgetEndedHolds();
        this.releaseAudioIfOwnerEnded();
        this.withdrawSettledNotifications();
      });

    // Every listener is registered here, not in setup(): callkeep flushes the
    // events it buffered while JavaScript was starting as soon as the bundle
    // finishes loading, which can be before an app gets around to calling
    // setup(). A listener added later receives nothing, and on a cold start
    // that is every event the call has had so far — the incoming-call display
    // and the user's answer both happen before React mounts. And on iOS the
    // first listener starts callkeep's observing, after which it sends every
    // CallKit action live instead of buffering it: an answer or an end made
    // between this constructor and a later setup() reached no listener.
    // Guarded: callkeep is an optional peer, and this runs in the constructor
    // — before setup() has had a chance to assert it is installed. An app that
    // only wants the SDK, with no native call UI, must not crash on import.
    if (typeof RNCallKeep?.addEventListener === 'function') {
      // Before the listeners: a replayed activation must find WebRTC's audio
      // under CallKit's control already.
      this.webrtcAudio.adopt();
      this.listen<LoadedEvent[]>('didLoadWithEvents', (events) => this.handleLoadedEvents(events));
      this.registerNativeListeners();
    }
  }

  /**
   * Performs the native handshake. Call once, from the app entry file.
   *
   * Overlapping calls share one handshake: the guard used to be read before
   * the await and set after it, so two calls in one run both went through.
   * A failed setup can be retried.
   */
  setup(options: CallKitSetupOptions): Promise<void> {
    this.setupPromise ??= this.performSetup(options).catch((error: unknown) => {
      this.setupPromise = null;
      throw error;
    });
    return this.setupPromise;
  }

  private async performSetup(options: CallKitSetupOptions): Promise<void> {
    // The native module, not the JS wrapper: callkeep's default export is a
    // class instance that always has `setup`, so an installed but unlinked
    // callkeep passed the wrapper check and failed later with a TypeError,
    // in setup() and in every startCall the observer made.
    const callKeep = requireCallKeep('native call UI');
    assertPeerModule(
      (NativeModules as Record<string, object | undefined> | undefined)?.RNCallKeep,
      callKeep.packageName,
      'native call UI',
      'setup'
    );

    this.supportsVideo = options.supportsVideo ?? false;
    this._callWaiting = options.callWaiting ?? 'full';
    this.endCallsOnHostDestroy = options.endCallsOnHostDestroy ?? false;
    this.registry.setCallLimit(callLimitFor(this._callWaiting));
    this.incomingChannelName = options.androidIncomingChannelName ?? 'Incoming calls';
    // The registry was built before setup() by getCallKit(), with no options.
    if (options.fusionTimeoutMs !== undefined) {
      this.registry.setFusionTimeoutMs(options.fusionTimeoutMs);
    }

    await RNCallKeep.setup({
      ios: {
        appName: options.appName,
        imageName: options.imageName,
        ringtoneSound: options.ringtoneSound,
        supportsVideo: this.supportsVideo,
        includesCallsInRecents: options.includesCallsInRecents ?? true,
        // Two groups for call waiting: CallKit then offers Hold & Accept
        // beside End & Accept, and holds and swaps the two calls. One group
        // offers End & Accept only. A group is one call: no merging.
        maximumCallGroups: this._callWaiting === 'full' ? '2' : '1',
        maximumCallsPerCallGroup: '1'
      },
      android: {
        alertTitle: 'Permissions required',
        alertDescription: `${options.appName} needs permission to manage phone calls.`,
        cancelButton: 'Cancel',
        okButton: 'OK',
        imageName: options.imageName,
        // callkeep requests no permissions in self-managed mode, so
        // `additionalPermissions` would do nothing; see requestAndroidPermissions.
        selfManaged: true,
        // false (the default): the activity closing mid-call (Back on the
        // root screen) leaves the call running, with its ongoing-call
        // notification, and the provider keeps the client. true: callkeep
        // disconnects each connection and sends endCall, which hangs up the
        // SDK call (handleEndCall). Stock callkeep 4.3.10+ kills the process
        // right after, before that endCall reaches JavaScript, so the call
        // stayed up on SignalWire; the fork doesn't, and reads this option.
        endCallsOnHostDestroy: this.endCallsOnHostDestroy,
        foregroundService: {
          channelId: options.androidChannelId ?? 'signalwire-calls',
          channelName: options.androidChannelName ?? 'Ongoing calls',
          notificationTitle: 'Call in progress',
          notificationIcon: options.androidNotificationIcon ?? 'ic_launcher'
        }
      }
    } as never);

    RNCallKeep.setAvailable(true);
    this.adoptingLaunchPush = true;
    this.isSetup = true;
    // A live entry's call gets its audio session from this bridge, so while
    // one exists a route chosen with no session (a tap while an outbound
    // call rings) waits for it; when the last one ends without a session the
    // choice is dropped. Keyed on the entries, not on audio start/stop: a
    // call that never starts audio ends with neither.
    this.requestAndroidPermissions();
    this.registry.entries$
      .pipe(
        map((entries) => entries.some((entry) => entry.state !== 'ended')),
        distinctUntilChanged(),
        takeUntil(this.destroyed$)
      )
      .subscribe((live) => {
        this.expectingAudio = live;
        this.withAudioRoutes('debug', (audio) => audio.expectSession(live));
      });
    try {
      for (const pending of await getPendingVoipCalls()) {
        await this.adoptPendingNativeCall(pending);
      }
    } finally {
      this.adoptingLaunchPush = false;
    }
    logger.info(`CallKit ready (callWaiting: ${this._callWaiting}, endCallsOnHostDestroy: ${String(this.endCallsOnHostDestroy)})`);
  }

  /**
   * Emits each call-back the user starts from Recents or Siri, for the app to
   * dial. A call-back that arrived before anyone subscribed (the tap launched
   * the app) is delivered to the first subscriber, once, if it is under a
   * minute old. CallKit's report of the app's own outbound calls is not
   * included.
   *
   * On iOS this needs the Expo plugin's `continueUserActivity` forwarder
   * (`enableCallKit`, the default), or, without Expo, an AppDelegate that
   * passes the activity to `[RNCallKeep application:continueUserActivity:restorationHandler:]`.
   */
  get startCallRequested$(): Observable<StartCallRequest> {
    return defer(() => {
      const cutoff = Date.now() - START_REQUEST_TTL_MS;
      const held = this.heldStartRequests.filter((entry) => entry.at >= cutoff).map((entry) => entry.request);
      this.heldStartRequests = [];
      return concat(from(held), this._startCallRequested$);
    });
  }

  /** The call-waiting mode `setup()` was given; see {@link CallWaitingMode}. */
  get callWaiting(): CallWaitingMode {
    return this._callWaiting;
  }

  /**
   * Whether `SignalWireProvider` keeps the client and its calls when the app
   * unmounts during a call: the opposite of `endCallsOnHostDestroy`.
   */
  get keepsCallsOnUnmount(): boolean {
    return !this.endCallsOnHostDestroy;
  }

  /**
   * Reports a VoIP push. Safe to call before `setup()` resolves and before
   * React mounts — that is the whole point of the singleton.
   */
  reportIncomingPush(payload: PushPayload): string {
    const uuid = this.registry.reportIncomingPush(payload);
    this.ensureTicking();
    return uuid;
  }

  /**
   * Mirrors the SDK's inbound calls into the registry.
   *
   * `SignalWireProvider` calls this immediately after constructing the client,
   * *before* it has connected — at which point `client.session` does not exist
   * yet. Reading it eagerly throws and takes the app down on launch, so the
   * subscription is deferred until the client reports a connection, and
   * re-established on every reconnect because the session is replaced.
   *
   * A client with no `isConnected$` (older SDKs, and the mocks in this
   * package's tests) is treated as already connected.
   *
   * A client is subscribed to once however often it is bound. Returns this
   * binder's unbind (the provider calls it when `callKit` is turned off):
   * once every binder of the client has unbound it, its inbound calls no
   * longer reach CallKit.
   */
  bindClient(client: SignalWire): () => void {
    const existing = this.boundClients.get(client);
    if (existing) {
      existing.binders += 1;
      return this.unbinderFor(existing);
    }
    const connected$ = client.isConnected$ ?? of(true);

    const subscription = connected$
      .pipe(
        switchMap(() => client.session?.incomingCalls$ ?? EMPTY),
        takeUntil(this.destroyed$),
        finalize(() => this.boundClients.delete(client))
      )
      .subscribe((calls) => {
        for (const call of calls) {
          if (!this.registry.uuidForCall(call)) {
            // Marked first: attaching shows the call in CallKit, which reads its media.
            this.inboundCalls.add(call);
            if (!this.registry.attachIncomingCall(call)) {
              // Refused as busy: never shown, nothing to watch.
              this.inboundCalls.delete(call);
              continue;
            }
            this.watchCallStatus(call);
          }
        }
      });
    if (subscription.closed) {
      return () => undefined;
    }
    const binding = { subscription, binders: 1 };
    this.boundClients.set(client, binding);
    return this.unbinderFor(binding);
  }

  /**
   * One binder's unbind. The client stays bound until its last binder
   * unbinds: two providers, or a provider and the app's own call, can bind
   * the same client, and one of them unmounting must not stop the other's
   * calls reaching CallKit. Calling it twice counts once. The client's
   * boundClients entry goes with the subscription (bindClient's finalize).
   */
  private unbinderFor(binding: { subscription: Subscription; binders: number }): () => void {
    let unbound = false;
    return () => {
      if (unbound) {
        return;
      }
      unbound = true;
      binding.binders -= 1;
      if (binding.binders === 0) {
        binding.subscription.unsubscribe();
      }
    };
  }

  /**
   * Answers an in-app-accepted call through the native UI instead of the SDK.
   *
   * `RNCallKeep.answerIncomingCall` performs the CallKit answer action: iOS
   * dismisses its ringing screen, activates the audio session (releasing the
   * `didActivateAudioSession` gate), and our `answerCall` listener runs the
   * same registry flow as a lock-screen answer. Returns `false` when the call
   * is unknown to the registry, in which case the caller must answer the SDK
   * directly.
   */
  answerIncomingFromApp(call: Call, others: OtherCalls = 'hold'): boolean {
    const uuid = this.registry.uuidForCall(call);
    if (!uuid || !this.isSetup || this.refused.has(uuid)) {
      // The fallback is the silent-call trap, so a decline must say why.
      logger.debug(
        `In-app answer NOT routed through CallKit (uuid=${String(uuid)}, setup=${this.isSetup}); answering the SDK directly`
      );
      return false;
    }
    logger.debug(`In-app answer routed through CallKit for ${uuid}`);
    this.claimAudio(uuid);
    this.settleOtherCalls(uuid, others);
    RNCallKeep.answerIncomingCall(uuid);
    return true;
  }

  /**
   * Answers a ringing push (an entry with no SDK call yet) from the app's own
   * UI, holding or ending the calls already live first, as
   * {@link answerIncomingFromApp} does for an SDK call. The answer is the
   * registry's intent: a call arriving for the push is answered, or the app
   * dials its bridge (`answerRequested$`).
   */
  answerPushFromApp(uuid: string, others: OtherCalls = 'hold'): void {
    if (!this.registry.isLive(uuid)) {
      return;
    }
    this.settleOtherCalls(uuid, others);
    this.registry.applyIntent(uuid, 'answer');
  }

  /**
   * The app put a call on hold or took it off (`useCalls()`): CallKit and
   * Telecom are told, so their screens agree. Their echo of it is a no-op.
   */
  mirrorHold(call: Call, held: boolean): void {
    const uuid = this.registry.uuidForCall(call);
    if (!uuid || !this.registry.isLive(uuid)) {
      return;
    }
    this.wantHeld.set(uuid, held);
    if (this.isSetup && !this.refused.has(uuid) && typeof RNCallKeep?.setOnHold === 'function') {
      RNCallKeep.setOnHold(uuid, held);
    }
    this.followActiveCall();
  }

  /**
   * Whether an SDK incoming call was turned down here (busy under the
   * call-waiting policy, or declined): the app's incoming list must not
   * offer it. See {@link CallRegistry.isRefused}.
   */
  isIncomingRefused(call: Call): boolean {
    return this.registry.isRefused(call);
  }

  /** The reject twin of {@link answerIncomingFromApp}. */
  rejectIncomingFromApp(call: Call): boolean {
    const uuid = this.registry.uuidForCall(call);
    if (!uuid || !this.isSetup || this.refused.has(uuid)) {
      logger.debug(
        `In-app reject NOT routed through CallKit (uuid=${String(uuid)}, setup=${this.isSetup})`
      );
      return false;
    }
    logger.debug(`In-app reject routed through CallKit for ${uuid}`);
    RNCallKeep.rejectCall(uuid);
    return true;
  }

  /**
   * Attaches a call placed in response to a native answer to its existing
   * entry. See {@link CallRegistry.bindCall}.
   *
   * Returns `false` when the entry is gone — the parked caller hung up, or
   * the user declined, while the call was being placed — in which case hang
   * the call straight back up rather than leaving it live with no native UI.
   */
  bindBridgeCall(uuid: string, call: Call): boolean {
    // Bound already: trackCall's claim binds the dial's call, and the app
    // binds it again once the dial returns. Binding again would watch it
    // twice (two connected reports, two audio waits, two remote ends).
    if (this.registry.entryForUuid(uuid)?.call === call) {
      return this.registry.isLive(uuid);
    }
    const bound = this.registry.bindCall(uuid, call);
    if (bound) {
      this.watchCallStatus(call);
      this.showBoundCallType(uuid);
    }
    return bound;
  }

  /**
   * Claims the next outbound call for an entry that is already on screen.
   *
   * A bridge answer dials out to join a caller the user has *already*
   * answered, so the native entry exists. Without this claim the dial takes
   * the ordinary outbound path and reports a second call to CallKit while the
   * answered one is still live — CallKit rejects the transaction
   * ("Error requesting transaction"), the dial dies, and the entry is torn
   * down as missed. Nothing in the logs names the cause.
   *
   * Paired with {@link endBridgeDial}, which must run whether or not the dial
   * succeeded: a claim left behind would swallow the next ordinary call.
   */
  beginBridgeDial(uuid: string): void {
    this.pendingBridgeUuid = uuid;
  }

  /** Releases a claim made by {@link beginBridgeDial}. */
  endBridgeDial(): void {
    this.pendingBridgeUuid = null;
  }

  /**
   * Makes a pushed call visible, for a call the OS will not show.
   *
   * Android wakes a killed app into a headless task to handle the push, so
   * JavaScript runs but no activity does, and with a self-managed
   * ConnectionService the system draws nothing either.
   *
   * With the package's Android module linked this does nothing: Telecom asks
   * for incoming-call UI (`showIncomingCallUi`) once the connection exists,
   * and the bridge posts the incoming-call notification, which rings, shows
   * over the lock screen and carries Answer and Decline. Starting the activity
   * from the headless task instead is a background activity start: refused on
   * Android 10+ unless an exemption applies, and behind the keyguard when the
   * phone is locked. Without the module (an app not rebuilt since installing
   * this version) it still tries that, as before.
   *
   * iOS never needs this: CallKit puts its own screen up, over the lock
   * screen if it has to.
   */
  bringToForeground(): void {
    if (Platform.OS !== 'android' || typeof RNCallKeep?.backToForeground !== 'function') {
      return;
    }
    if (incomingCallModule()) {
      return;
    }
    try {
      RNCallKeep.backToForeground();
    } catch (error) {
      // Android restricts background activity starts, and this is
      // best-effort: the call is still in Telecom either way.
      logger.warn('Could not bring the app to the foreground:', error);
    }
  }

  /**
   * Throws {@link CallInProgressError} if starting an outbound call now would
   * be a second call: any live entry counts, a ringing push included, because
   * CallKit is set up for one call and refuses another start. A bridge dial
   * for a live, claimed entry ({@link beginBridgeDial}) passes, since its call
   * joins the entry already on screen. The CallKit observer calls this before
   * `dial()` reaches the SDK.
   */
  assertCanDial(): void {
    const claimed = this.pendingBridgeUuid;
    if (claimed !== null && this.registry.isLive(claimed)) {
      return;
    }
    const busy = this.dialBlocker();
    if (busy) {
      throw new CallInProgressError(busy.uuid);
    }
  }

  /**
   * The live call that keeps another from being placed: any live entry
   * (a ringing push included) unless call waiting is on, and then one once
   * two calls are live.
   */
  private dialBlocker(): CallEntry | undefined {
    const live = this.registry.liveEntries;
    const limit = this._callWaiting === 'full' ? 2 : 1;
    return live.length >= limit ? live[0] : undefined;
  }

  /**
   * Registers an outbound call with the native UI. Returns its UUID.
   *
   * Whether it is a video call comes from the call itself
   * (`call.mediaDirections`, the SDK's own offer, after preferences,
   * `?channel=`, the dial options and a disabled camera are all applied): a
   * voice call starts on the receiver (or a connected headset or car), a video
   * call on the loudspeaker. A call without `mediaDirections` is a voice
   * call: `supportsVideo` says the native UI may show video, not that a call
   * has it.
   *
   * A second call while another is live (one that got past
   * {@link assertCanDial}, such as two dials racing) is hung up and refused
   * with {@link CallInProgressError}: CallKit would refuse its start
   * transaction, and the registry must not hold a call CallKit never took.
   */
  trackCall(call: Call, handle: string, displayName: string): string {
    // Tracked already (the app tracked a call the provider's observer also
    // tracks): a second status watch would report it connected twice and
    // start two audio waits.
    const known = this.registry.uuidForCall(call);
    if (known !== undefined) {
      return known;
    }
    const claimed = this.pendingBridgeUuid;
    if (claimed !== null) {
      this.pendingBridgeUuid = null;
      if (this.bindBridgeCall(claimed, call)) {
        logger.debug(`Adopted bridge call ${call.id} into existing entry ${claimed}`);
        return claimed;
      }
      const entry = this.registry.entryForUuid(claimed);
      if (entry) {
        // The entry cannot take this call: the user ended the answered push,
        // it ended on its own (the answered timeout, the app's endCall), or
        // it already has its call (a second dial for one answer). Reported as
        // a new outgoing call, it rang as one and was hung up at once by the
        // app's failed bind. Nothing here is live: no second native call.
        logger.debug(`Entry ${entry.uuid} cannot take bridge call ${call.id}; hanging up`);
        void call.hangup().catch((error: unknown) => {
          logger.debug('Hangup of the abandoned bridge call failed:', error);
        });
        return entry.uuid;
      }
      // A claim for a uuid the registry never had. Fall through and report a
      // normal outbound call, so the user is not left on a live call with no
      // native UI to end it.
      logger.debug(`Entry ${claimed} vanished during the bridge dial`);
    }

    const tracked = this.registry.uuidForCall(call);
    if (tracked) {
      return tracked;
    }
    const live = this.dialBlocker();
    if (live) {
      logger.warn(`Refusing outbound call ${call.id}: ${live.uuid} is still live; hanging it up`);
      void call.hangup().catch((error: unknown) => {
        logger.debug('Hangup of the refused second call failed:', error);
      });
      throw new CallInProgressError(live.uuid);
    }

    const uuid = this.registry.attachOutgoingCall(call, handle, displayName);
    this.audioClaims.add(uuid);
    this.watchCallStatus(call);
    // Deliberate breadcrumb: RNCallKeep's own logs are NSLog-only, invisible in
    // Metro when launched outside Xcode, so without this line the entire
    // outbound CallKit path is indistinguishable from never having run.
    logger.debug(`Tracking outbound call ${uuid} for ${handle}`);
    return uuid;
  }

  destroy(): void {
    this.permissionsWait?.remove();
    this.permissionsWait = null;
    for (const uuid of [...this.notified]) {
      this.withdrawNotification(uuid);
    }
    if (this.expectingAudio) {
      this.expectingAudio = false;
      this.withAudioRoutes('debug', (audio) => audio.expectSession(false));
    }
    this.destroyed$.next();
    this.destroyed$.complete();
    this.stopTicking();
    this.clearHandoverTimer();
    if (this.audioUuid !== null) {
      this.stopAudio(this.audioUuid);
    }
    for (const listener of this.nativeListeners.splice(0)) {
      listener.remove();
    }
    this.webrtcAudio.release();
    this.heldActions.clear();
    this.wantHeld.clear();
    this.registry.destroy();
    this._startCallRequested$.complete();
    this.heldStartRequests = [];
    this.refused.clear();
    this.isSetup = false;
    this.setupPromise = null;
  }

  // ---------------------------------------------------------------- internals

  /**
   * Adds a callkeep handler and keeps what removes it for destroy(); see
   * {@link nativeListeners}. callkeep 4.3.9+ returns that from
   * addEventListener. 4.3.0-4.3.8 return nothing: they put the subscription in
   * `_callkeepEventHandlers` under its type, which a later handler of the same
   * type overwrites, so it is read back right away, while it is still this
   * handler's.
   */
  private listen<T>(type: string, handler: (event: T) => void): void {
    const added: unknown = (
      RNCallKeep.addEventListener as unknown as (type: string, handler: (event: T) => void) => unknown
    )(type, handler);
    const legacy = (RNCallKeep as unknown as { _callkeepEventHandlers?: Map<string, unknown> })
      ._callkeepEventHandlers;
    const listener = isRemovable(added) ? added : legacy?.get(type);
    if (isRemovable(listener)) {
      this.nativeListeners.push(listener);
    } else {
      logger.warn(`callkeep gave no way to remove the bridge's ${type} handler`);
    }
  }

  private registerNativeListeners(): void {
    // A VoIP push is reported to CallKit natively, before JavaScript exists.
    // This is how the registry learns about a call that is already ringing:
    // without it the entry is created only when the app happens to be running,
    // and a cold-start answer has nothing to apply an intent to.
    this.listen<DisplayEvent>('didDisplayIncomingCall', (event) =>
      this.handleDidDisplayIncomingCall(event)
    );

    this.listen<{ callUUID: string }>('answerCall', ({ callUUID }) =>
      this.handleAnswerCall(callUUID)
    );

    this.registerRemainingListeners();
  }

  /**
   * Rebuilds the entry for a call this launch was woken by.
   *
   * A cold start is the normal case for an incoming call, and in it the
   * CallKit screen is already on display before any JavaScript runs. Without
   * this the registry has no entry, so the answer that follows is applied to
   * nothing: no bridge is dialled and the caller waits on a parked leg until
   * it times out.
   */
  private async adoptPendingNativeCall(pending: PendingCall): Promise<void> {
    // Forgotten whether or not it is adopted here: the native cache outlives
    // this JS context, and the next setup() in the process would adopt it again.
    await forgetPendingVoipCall(pending.uuid);
    if (this.registry.entryForUuid(pending.uuid)) {
      return;
    }

    const { uuid, callId, handle, callerName, ...rest } = pending;
    logger.debug(`Adopting pending native call ${uuid} from the launch push`);
    this.adoptPushed(uuid, callId, handle ?? 'Unknown', callerName ?? 'Incoming call', rest);
  }

  /** Replays the events callkeep buffered while JavaScript was starting. */
  private handleLoadedEvents(events: LoadedEvent[]): void {
    // Logged even when empty: "callkeep never flushed" and "callkeep flushed
    // nothing" are different faults with the same silence.
    logger.debug(`didLoadWithEvents: ${Array.isArray(events) ? events.length : 'not-an-array'}`);
    if (!Array.isArray(events) || events.length === 0) {
      return;
    }
    for (const event of events) {
      logger.debug(`  replayed event: ${String(event?.name)}`);
    }

    // Order matters: a display must be adopted before its answer is applied,
    // and callkeep delivers them in the order they happened.
    for (const event of events) {
      if (event?.name === 'RNCallKeepDidDisplayIncomingCall') {
        this.handleDidDisplayIncomingCall(event.data as DisplayEvent);
      } else if (event?.name === 'RNCallKeepPerformAnswerCallAction') {
        this.replayAction((event.data as { callUUID: string }).callUUID, 'answer');
      } else if (event?.name === 'RNCallKeepPerformEndCallAction') {
        this.replayAction((event.data as { callUUID: string }).callUUID, 'end');
      } else if (event?.name === 'RNCallKeepDidActivateAudioSession') {
        this.handleAudioSessionActivated();
      } else if (event?.name === 'RNCallKeepDidDeactivateAudioSession') {
        this.handleAudioSessionDeactivated();
      } else if (event?.name === 'RNCallKeepDidReceiveStartCallAction') {
        this.handleStartCallAction(event.data as StartCallEvent);
      } else if (event?.name === 'RNCallKeepDidFailCallAction') {
        this.handleCallActionFailed(event.data as FailedActionEvent);
      }
    }
    // callkeep keeps this buffer for the life of the process and sends it
    // again on every startObserving (an in-process JS reload, say). Replayed a
    // second time, an old answer would start audio for a call that is over,
    // and an old activation would claim a session that is gone.
    if (typeof RNCallKeep.clearInitialEvents === 'function') {
      RNCallKeep.clearInitialEvents();
    }
  }

  /**
   * Applies a replayed answer or end, or holds it for a uuid the registry
   * doesn't know yet. On a cold start the display event is in the replay only
   * if callkeep's module existed when PushKit reported the call; under the new
   * architecture it is created lazily, later, so the answer can arrive first
   * and the entry only when setup() adopts the cached launch push.
   */
  private replayAction(uuid: string, action: 'answer' | 'end'): void {
    if (this.registry.entryForUuid(uuid)) {
      this.runAction(uuid, action);
      return;
    }
    this.holdAction(uuid, action, 'replayed');
  }

  /**
   * A live answer or end, held the same way when it arrives while setup() is
   * still fetching the launch push it belongs to: the listeners are up by
   * then, and the entry is not.
   */
  private liveAction(uuid: string, action: 'answer' | 'end'): boolean {
    if (!this.adoptingLaunchPush || this.registry.entryForUuid(uuid)) {
      return false;
    }
    this.holdAction(uuid, action, 'live');
    return true;
  }

  private holdAction(uuid: string, action: 'answer' | 'end', kind: 'replayed' | 'live'): void {
    logger.debug(`Holding the ${kind} ${action} for ${uuid} until its entry is adopted`);
    const held = this.heldActions.get(uuid);
    this.heldActions.set(uuid, {
      actions: [...(held?.actions ?? []), action],
      deadline: held?.deadline ?? Date.now() + this.holdTimeoutMs
    });
    this.ensureTicking();
  }

  private applyHeldActions(uuid: string): void {
    const held = this.heldActions.get(uuid);
    if (!held) {
      return;
    }
    this.heldActions.delete(uuid);
    for (const action of held.actions) {
      this.runAction(uuid, action);
    }
  }

  /**
   * Drops held actions whose entry never came. CallKit still shows an
   * answered call for one, with nothing behind it, so it is ended as missed;
   * one the user already ended needs nothing more.
   */
  private expireHeldActions(): void {
    const now = Date.now();
    for (const [uuid, held] of [...this.heldActions]) {
      if (now <= held.deadline) {
        continue;
      }
      this.heldActions.delete(uuid);
      if (!held.actions.includes('end')) {
        logger.warn(`The push for ${uuid} was never adopted; ending its answered call.`);
        RNCallKeep.reportEndCallWithUUID(uuid, this.endReasonFor('missed'));
      }
    }
  }

  private runAction(uuid: string, action: 'answer' | 'end'): void {
    if (action === 'answer') {
      this.handleAnswerCall(uuid);
    } else {
      this.handleEndCall(uuid);
    }
  }

  private handleAnswerCall(callUUID: string): void {
    logger.debug(`Native answer for ${callUUID}`);
    this.withdrawNotification(callUUID);
    if (this.liveAction(callUUID, 'answer')) {
      return;
    }
    // Applied synchronously — the registry buffers it when the SDK call has
    // not arrived yet. Only the audio start waits for the audio session.
    this.claimAudio(callUUID);
    // A call answered while another is live: CallKit's Hold & Accept and End
    // & Accept have already held or ended it, but an answer from Telecom or
    // the incoming-call notification has not.
    if (this.registry.isLive(callUUID)) {
      this.settleOtherCalls(callUUID, 'hold');
    }
    this.registry.applyIntent(callUUID, 'answer');
    void this.startAudioWhenSessionReady(callUUID);
  }

  /** Audio, if this call owns it, is released by {@link releaseAudioIfOwnerEnded}. */
  private handleEndCall(callUUID: string): void {
    logger.debug(`Native end for ${callUUID}`);
    this.withdrawNotification(callUUID);
    if (this.liveAction(callUUID, 'end')) {
      return;
    }
    const entry = this.registry.entryForUuid(callUUID);
    if (entry?.state === 'pending-push') {
      this.declineNatively(callUUID);
      return;
    }
    this.registry.endCall(callUUID);
  }

  private handleDidDisplayIncomingCall(event: DisplayEvent): void {
    // 'CallUUIDAlreadyExists' means the call is on screen already.
    if (event.errorCode && event.errorCode !== 'CallUUIDAlreadyExists') {
      this.handleDisplayRefused(event.callUUID, event.errorCode);
      return;
    }
    const { callUUID, handle, localizedCallerName, fromPushKit, payload } = event;
    if (fromPushKit !== '1') {
      return;
    }
    const { callId, ...fields } = (payload ?? {}) as Record<string, unknown>;
    logger.debug(`Native push displayed ${callUUID}`);
    this.adoptPushed(
      callUUID,
      typeof callId === 'string' ? callId : undefined,
      handle,
      localizedCallerName,
      fields
    );
    // The native side caches each displayed VoIP push for a cold start;
    // this one has been seen.
    void forgetPendingVoipCall(callUUID);
  }

  /**
   * Adopts a call the native side already displayed: from the launch push's
   * cache or from callkeep's display event. The push's other string fields
   * become the entry's data.
   */
  private adoptPushed(
    uuid: string,
    callId: string | undefined,
    from: string,
    fromName: string,
    fields: Record<string, unknown>
  ): void {
    const data: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === 'string') {
        data[key] = value;
      }
    }
    this.registry.adoptNativeEntry({
      uuid,
      callId: callId && callId.length > 0 ? callId : undefined,
      from,
      fromName,
      data: Object.keys(data).length > 0 ? data : undefined
    });
    this.ensureTicking();
    this.applyHeldActions(uuid);
  }

  /**
   * CallKit refused to show a call (a Focus mode that does not allow the
   * caller, the block list, no entitlement). It has no such call, so an
   * answer or decline requested from it fails, and callkeep only NSLogs
   * that: the app's own Accept and Decline did nothing. The call's in-app
   * actions now go straight to the SDK. A push entry that has no SDK call is
   * ended, rather than adopted or left as a ringing push iOS chose not to ring.
   */
  private handleDisplayRefused(uuid: string, errorCode: string): void {
    logger.warn(`CallKit refused to show call ${uuid} (${errorCode})`);
    this.refused.add(uuid);
    const entry = this.registry.entryForUuid(uuid);
    if (entry?.state === 'pending-push' && !entry.call) {
      this.registry.endCall(uuid);
    }
  }

  private registerRemainingListeners(): void {
    this.listen<{ callUUID: string }>('endCall', ({ callUUID }) => this.handleEndCall(callUUID));

    this.listen<{ callUUID: string; digits: string }>(
      'didPerformDTMFAction',
      ({ callUUID, digits }) => {
        void this.registry.entryForUuid(callUUID)?.call?.sendDigits(digits);
      }
    );

    this.listen<{ callUUID: string; hold: boolean }>('didToggleHoldCallAction', ({ callUUID, hold }) =>
      this.handleSetHeld(callUUID, hold)
    );

    this.listen<{ callUUID: string; muted: boolean }>(
      'didPerformSetMutedCallAction',
      ({ callUUID, muted }) => this.handleSetMuted(callUUID, muted)
    );

    // iOS only. Starting media before this fires yields a silent call.
    this.listen('didActivateAudioSession', () => {
      logger.debug('Audio session activated');
      this.handleAudioSessionActivated();
    });

    this.listen('didDeactivateAudioSession', () => {
      logger.debug('Audio session deactivated');
      this.handleAudioSessionDeactivated();
    });

    // A provider reset ends every call and its session, with no deactivation
    // event of its own.
    this.listen('didResetProvider', () => this.handleProviderReset());

    // Recents and Siri call-backs; on iOS also CallKit's echo of our own
    // startCall, which handleStartCallAction drops.
    this.listen<StartCallEvent>('didReceiveStartCallAction', (event) =>
      this.handleStartCallAction(event)
    );

    // Android only: Telecom asks a self-managed app to show its own ringing UI.
    this.listen<ConnectionEvent>('showIncomingCallUi', (event) => this.handleShowIncomingCallUi(event));
    this.listen<ConnectionEvent>('createIncomingConnectionFailed', (event) =>
      this.handleConnectionFailed(event)
    );

    // The SignalWire callkeep fork only; stock callkeep throws for an event
    // name it doesn't know.
    try {
      this.listen<FailedActionEvent>('didFailCallAction', (event) => this.handleCallActionFailed(event));
    } catch (error) {
      logger.debug('callkeep has no didFailCallAction (stock callkeep):', error);
    }
  }

  /**
   * CallKit refused a call action the bridge asked for, or Telecom refused to
   * start a call. After a refused start, answer or end, or any refusal for a
   * call CallKit no longer knows (UnknownCallUUID), the native side has no
   * call: the entry is dropped and its SDK call hung up, which would
   * otherwise run on with no native UI and nothing to end it from. A refused
   * hold, mute or DTMF for a call CallKit still has is only logged.
   */
  private handleCallActionFailed(event: FailedActionEvent): void {
    const uuid = typeof event?.callUUID === 'string' ? event.callUUID : '';
    const action = event?.action ?? 'unknown';
    const errorCode = event?.errorCode ?? 'Unknown';
    const entry = uuid ? this.registry.entryForUuid(uuid) : undefined;
    if (!entry || !this.registry.isLive(entry.uuid)) {
      logger.debug(`Native ${action} refused (${errorCode}) for ${uuid || 'no call'}; no live call`);
      return;
    }
    const lost = CALL_ACTIONS.has(action) || errorCode === 'UnknownCallUUID';
    logger.warn(
      `${Platform.OS === 'ios' ? 'CallKit' : 'Telecom'} refused ${action} for call ${entry.uuid} (${errorCode})` +
        (lost ? '; ending the call' : '')
    );
    if (!lost) {
      return;
    }
    this.refused.add(entry.uuid);
    this.withdrawNotification(entry.uuid);
    this.registry.endCall(entry.uuid, action === 'endCall' ? 'local' : 'failed');
  }

  private handleStartCallAction(event: StartCallEvent): void {
    const handle = typeof event?.handle === 'string' ? event.handle : '';
    if (handle.length === 0) {
      return;
    }
    // CallKit (and Telecom) report the app's own startCall as a start action
    // with its uuid: that call is already placed.
    if (event.callUUID && this.registry.entryForUuid(event.callUUID)) {
      return;
    }
    const request: StartCallRequest = {
      handle,
      displayName: typeof event.name === 'string' && event.name.length > 0 ? event.name : undefined,
      video: event.video === true
    };
    logger.debug(`Call-back requested for ${handle}`);
    if (this._startCallRequested$.observed) {
      this._startCallRequested$.next(request);
    } else {
      this.heldStartRequests.push({ request, at: Date.now() });
    }
  }

  /**
   * Posts the incoming-call notification, when the app is not on screen.
   *
   * In the foreground the app shows its own ringing UI (`useRingingPushes`,
   * or its handling of `incomingCalls$`), so a heads-up notification on top
   * would only duplicate it.
   */
  private handleShowIncomingCallUi(event: ConnectionEvent): void {
    const entry = this.registry.entryForUuid(event.callUUID);
    const module = incomingCallModule();
    if (!entry || !this.registry.isLive(entry.uuid) || !module) {
      return;
    }
    if (AppState.currentState === 'active') {
      logger.debug(`Incoming call ${entry.uuid} rings in the app`);
      return;
    }
    this.notified.add(entry.uuid);
    this.lockScreenHeld = true;
    logger.debug(`Posting the incoming-call notification for ${entry.uuid}`);
    module
      .show(
        entry.uuid,
        decodeHandle(event.handle) ?? entry.handle,
        event.name ?? entry.displayName,
        event.hasVideo === 'true',
        this.incomingChannelName
      )
      .catch((error: unknown) => {
        logger.warn('Could not post the incoming-call notification:', error);
      });
  }

  /**
   * Telecom refused the incoming call (another call in progress, the system's
   * call limit, a phone account it no longer accepts). There is no connection,
   * so a callkeep answer or reject would do nothing: an SDK call is answered
   * and rejected in the app directly from now on, and a push with no call to
   * answer is over.
   */
  private handleConnectionFailed(event: ConnectionEvent): void {
    const entry = this.registry.entryForUuid(event.callUUID);
    if (!entry) {
      return;
    }
    logger.warn(`Telecom refused incoming call ${entry.uuid}`);
    this.refused.add(entry.uuid);
    this.withdrawNotification(entry.uuid);
    if (!entry.call) {
      this.registry.reportRemoteEnded(entry.uuid);
    }
  }

  /**
   * Withdraws notifications of calls that are no longer ringing, and lets the
   * lock screen back once no call is left.
   */
  private withdrawSettledNotifications(): void {
    for (const uuid of [...this.notified]) {
      const entry = this.registry.entryForUuid(uuid);
      if (!entry || !this.registry.isLive(uuid) || entry.intent !== null) {
        this.withdrawNotification(uuid);
      }
    }
    if (this.lockScreenHeld && !this.registry.entries.some((e) => this.registry.isLive(e.uuid))) {
      this.lockScreenHeld = false;
      try {
        incomingCallModule()?.release();
      } catch (error) {
        logger.debug('Could not release the lock screen:', error);
      }
    }
  }

  private withdrawNotification(uuid: string): void {
    if (!this.notified.delete(uuid)) {
      return;
    }
    try {
      incomingCallModule()?.cancel(uuid);
    } catch (error) {
      logger.debug('Could not withdraw the incoming-call notification:', error);
    }
  }

  /**
   * Asks for {@link androidCallPermissions}, once, with the app on screen.
   *
   * setup() runs from the entry file, which for a push to a killed app is a
   * headless task with no activity to ask from; then it waits for the app to
   * come forward. A refusal is logged, not thrown: Android decides what the
   * call can still do.
   */
  private requestAndroidPermissions(): void {
    if (Platform.OS !== 'android' || typeof PermissionsAndroid?.requestMultiple !== 'function') {
      return;
    }
    const request = () => {
      const permissions = androidCallPermissions();
      void PermissionsAndroid.requestMultiple(permissions as never)
        .then((results) => {
          const refused = Object.entries(results as Record<string, string>)
            .filter(([, result]) => result !== 'granted')
            .map(([permission]) => permission);
          if (refused.length > 0) {
            logger.warn(`Call permissions not granted: ${refused.join(', ')}`);
          }
        })
        .catch((error: unknown) => {
          logger.warn('Could not request the call permissions:', error);
        });
    };
    if (AppState.currentState === 'active') {
      request();
      return;
    }
    this.permissionsWait = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        return;
      }
      this.permissionsWait?.remove();
      this.permissionsWait = null;
      request();
    });
  }

  /**
   * Applies the hold state CallKit or Telecom asked for: the action carries it
   * (`hold: true|false`), and the SDK only toggles, so the state goes through
   * `getCallHoldState()`, which compares first and runs one request at a time
   * per call. A hold that fails is reported back with the real state, since
   * callkeep fulfils the action before the request is sent.
   */
  private handleSetHeld(uuid: string, hold: boolean): void {
    const call = this.registry.entryForUuid(uuid)?.call;
    if (!call || !this.registry.isLive(uuid)) {
      return;
    }
    this.wantHeld.set(uuid, hold);
    this.applyHold(uuid, call, hold);
  }

  /** Sets the SDK hold, then moves the session to whichever call is active. */
  private applyHold(uuid: string, call: Call, hold: boolean): void {
    const state = getCallHoldState();
    state.setHeld(call, hold).then(
      () => this.followActiveCall(),
      (error: unknown) => {
        logger.warn(`Could not ${hold ? 'hold' : 'resume'} call ${uuid}:`, error);
        const held = state.isHeld(call);
        this.wantHeld.set(uuid, held);
        // The native UI already shows the requested state; tell it the real one.
        if (this.registry.isLive(uuid) && typeof RNCallKeep.setOnHold === 'function') {
          RNCallKeep.setOnHold(uuid, held);
        }
      }
    );
  }

  /**
   * Holds or ends the live calls other than `uuid`, which is being answered:
   * Hold & Accept or End & Accept. Outside `'full'` call waiting there is no
   * second live call, so an answer ends the other. A call already held, or
   * asked to be, is left alone, and so is an entry whose call has not been
   * placed yet.
   */
  private settleOtherCalls(uuid: string, others: OtherCalls): void {
    const mode: OtherCalls = this._callWaiting === 'full' ? others : 'end';
    const target = uuid.toLowerCase();
    for (const entry of this.registry.liveEntries) {
      if (entry.uuid === target) {
        continue;
      }
      if (mode === 'end') {
        logger.debug(`Ending ${entry.uuid} to answer ${target}`);
        this.registry.endCall(entry.uuid);
        continue;
      }
      const call = entry.call;
      if (!call || this.wantHeld.get(entry.uuid) === true || getCallHoldState().isHeld(call)) {
        continue;
      }
      logger.debug(`Holding ${entry.uuid} to answer ${target}`);
      this.wantHeld.set(entry.uuid, true);
      if (!this.refused.has(entry.uuid) && typeof RNCallKeep.setOnHold === 'function') {
        RNCallKeep.setOnHold(entry.uuid, true);
      }
      this.applyHold(entry.uuid, call, true);
    }
  }

  /**
   * The live call with media: connected and not on hold (the newest, with
   * more than one).
   */
  private activeEntry(): CallEntry | undefined {
    const state = getCallHoldState();
    const active = this.registry.liveEntries.filter(
      (entry) =>
        entry.call !== null &&
        entry.call.status === 'connected' &&
        this.wantHeld.get(entry.uuid) !== true &&
        !state.isHeld(entry.call)
    );
    return active[active.length - 1];
  }

  /**
   * Moves the audio session to the active call, once a hold or swap changed
   * which call that is. One session serves both calls; on Android the
   * active call's Telecom connection routes it (the controller follows that
   * connection), on iOS CallKit routes the session for whichever is active.
   */
  private followActiveCall(): void {
    if (this.audioUuid === null) {
      return;
    }
    const active = this.activeEntry();
    if (!active || active.uuid === this.audioUuid) {
      return;
    }
    logger.debug(`Call ${active.uuid} is active; the audio session follows it from ${this.audioUuid}`);
    this.audioUuid = active.uuid;
    const media = this.audioMedia ?? 'audio';
    const telecomCall = this.refused.has(active.uuid) ? undefined : active.uuid;
    this.withAudioRoutes('debug', (controller) => controller.start(media, telecomCall));
  }

  /**
   * Applies a CallKit mute, or keeps it until the call has a self participant.
   *
   * An answered push has no call for the whole bridge dial, and an SDK call
   * has no `self` until it is joined. A mute tapped then was dropped while
   * CallKit showed Mute on, and the microphone went live when the call
   * connected. The last state asked for is applied when the participant
   * appears (see {@link watchCallStatus}).
   */
  private handleSetMuted(uuid: string, muted: boolean): void {
    if (!this.registry.isLive(uuid)) {
      return;
    }
    const participant = this.registry.entryForUuid(uuid)?.call?.self;
    if (!participant) {
      logger.debug(`Keeping the native ${muted ? 'mute' : 'unmute'} for ${uuid} until it joins`);
      this.pendingMute.set(uuid, muted);
      return;
    }
    this.pendingMute.delete(uuid);
    this.applyMute(uuid, participant, muted);
  }

  private applyMute(
    uuid: string,
    participant: { mute(): Promise<void>; unmute(): Promise<void> },
    muted: boolean
  ): void {
    void (muted ? participant.mute() : participant.unmute()).catch((error: unknown) => {
      logger.warn(`Could not ${muted ? 'mute' : 'unmute'} call ${uuid}:`, error);
    });
  }

  /**
   * CallKit dropped every call (callservicesd restarted, say) and sends no
   * endCall action for any of them. Each live entry is ended as a native end
   * would end it, which hangs up its SDK call; a ringing push is turned down.
   * Left in place, an entry outlived its call: the next call found the
   * session still owned by it, and ringing-push consumers still saw it.
   */
  private handleProviderReset(): void {
    logger.debug('CallKit provider reset; ending every call');
    for (const entry of this.registry.entries) {
      if (this.registry.isLive(entry.uuid)) {
        this.handleEndCall(entry.uuid);
      }
    }
    if (this.audioUuid !== null) {
      this.stopAudio(this.audioUuid);
    }
    // Ended calls release the session they own; the activation went with
    // the reset either way, and WebRTC's audio unit with it.
    this.handleAudioSessionDeactivated();
  }

  /**
   * CallKit activated the audio session: WebRTC's audio unit is (re)started
   * first, then the calls waiting for the session start their audio route.
   * Every activation restarts the unit, because CallKit stops it on each call
   * change and WebRTC is not told (see WebRTCAudioSessionLink).
   */
  private handleAudioSessionActivated(): void {
    this.webrtcAudio.didActivate();
    this.setAudioSessionActive(true);
  }

  private handleAudioSessionDeactivated(): void {
    this.webrtcAudio.didDeactivate();
    this.setAudioSessionActive(false);
  }

  private setAudioSessionActive(active: boolean): void {
    this.audioSessionActive$.next(active);
  }

  /**
   * Starts the audio route once CallKit activates the audio session, for a
   * call that is still live by then.
   *
   * Starting media before `didActivateAudioSession` yields a connected but
   * silent call on iOS. Android has no such event, so this runs immediately.
   * The timeout prevents a permanently silent call if the event never fires.
   * One activation releases every wait, so the answer-time and the
   * connect-time start of one inbound call go together.
   */
  private async startAudioWhenSessionReady(uuid: string): Promise<void> {
    if (Platform.OS === 'ios') {
      await firstValueFrom(
        this.audioSessionActive$.pipe(
          filter(Boolean),
          timeout({
            first: AUDIO_SESSION_TIMEOUT_MS,
            with: () => {
              // No activation came: WebRTC runs its audio unit anyway, as it
              // did on its own before manual audio, rather than stay silent.
              logger.warn(`No audio session activation in ${AUDIO_SESSION_TIMEOUT_MS} ms; starting audio anyway`);
              this.webrtcAudio.enableWithoutActivation();
              return of(true);
            }
          }),
          takeUntil(this.destroyed$)
        ),
        { defaultValue: false }
      );
    }
    // The call can end during the wait, including a push the user ended
    // before its SDK call existed. Started anyway, the session would stay up
    // with nothing left to stop it, and the next call, whose own start is
    // ignored because start() is first-wins, would inherit this call's mode.
    const entry = this.registry.entryForUuid(uuid);
    if (!entry || !this.registry.isLive(uuid)) {
      logger.debug(`Call ${uuid} ended before its audio session was ready; not starting audio`);
      return;
    }
    // A push answered before its SDK call exists: its media is unknown until
    // that call (or the bridge call placed for it) arrives, and the session
    // mode can't be changed once incall-manager has started. It starts when
    // that call connects, with that call's media.
    if (!entry.call) {
      logger.debug(`Call ${uuid} has no SDK call yet; its audio starts when that call connects`);
      return;
    }
    this.startAudio(uuid, this.mediaFor(entry.call));
  }

  /**
   * A call's media. An SDK inbound call has the media the registry answers
   * it with (INBOUND_ANSWER: voice). Its `mediaDirections` can't be used, because @signalwire/js
   * reports video for any offer whose m=video sends ('sendrecv' before the
   * answer, 'recvonly' after it), so a video caller's call would start on the
   * loudspeaker. An outbound call (the bridge call placed for a push
   * included) is video when it sends or receives video; one without
   * `mediaDirections`, or a destroyed one, is voice. `supportsVideo` never
   * makes a call video: it only lets the native UI show one as video. A
   * pushed entry whose call hasn't arrived yet is shown as voice, as iOS shows
   * every VoIP push: its call is answered audio-only, or is the app's own
   * bridge call, whose type is shown once it binds.
   */
  private mediaFor(call: Call | null | undefined): 'audio' | 'video' {
    if (!call) {
      return 'audio';
    }
    if (this.inboundCalls.has(call)) {
      return INBOUND_ANSWER.video ? 'video' : 'audio';
    }
    let video: string | undefined;
    try {
      // Optional-chained: a Call from an older SDK, or a test double, may not have it.
      video = call.mediaDirections?.video;
    } catch {
      // The getter throws once the call is destroyed ('Main peer connection not found').
      video = undefined;
    }
    if (video === undefined) {
      return 'audio';
    }
    return video === 'inactive' ? 'audio' : 'video';
  }

  /** Whether CallKit shows the entry as a video call: the call has video and the provider supports it. */
  private reportsVideo(uuid: string): boolean {
    return this.supportsVideo && this.mediaFor(this.registry.entryForUuid(uuid)?.call) === 'video';
  }

  /**
   * A pushed entry was shown as voice. When the call placed for it is a video
   * call, CallKit is told (`CXCallUpdate.hasVideo`, through callkeep's
   * `updateDisplay`, which also re-sends the name and handle). Android's
   * ConnectionService takes no type update from callkeep.
   *
   * Only for a caller whose handle is a phone number: callkeep's
   * updateDisplay takes no handle type and always rebuilds the remote handle
   * as CXHandleTypePhoneNumber, while the entry was reported generic, so a
   * `sip:` or Fabric address would turn into a "phone number" in CallKit and
   * Recents (and on a call-back). Such a call stays shown as voice; its audio
   * still starts with the bridge call's media.
   */
  private showBoundCallType(uuid: string): void {
    const entry = this.registry.entryForUuid(uuid);
    if (Platform.OS !== 'ios' || !entry || !this.reportsVideo(uuid)) {
      return;
    }
    if (!PHONE_NUMBER.test(entry.handle)) {
      logger.debug(`Not marking ${uuid} as video: updateDisplay would make "${entry.handle}" a phone number`);
      return;
    }
    if (typeof RNCallKeep.updateDisplay !== 'function') {
      return;
    }
    RNCallKeep.updateDisplay(uuid, entry.displayName, entry.handle, { ios: { hasVideo: true } });
  }

  /**
   * Starts the session for `uuid`, which then owns it. While another live
   * call owns it (a call waiting behind it was answered), the session is left
   * as it is: `AudioRouteController.start` is first-wins either way.
   *
   * A session handed over by an ended owner (see
   * {@link releaseAudioIfOwnerEnded}) is taken as it is, route included,
   * when it was started for this call's media. When it was started for other
   * media it is restarted for this call: incall-manager's start() is
   * first-wins, and its media fixes the session mode (VoiceChat or
   * VideoChat), the proximity sensor and the default route, so a voice call
   * would otherwise run in a video call's mode on the loudspeaker. The
   * restart runs here, after this call's own activation (or the fallback),
   * not between the ended call's endCall and this call's answerCall, where
   * stop()'s setActive:NO would hit the session CallKit is handing over.
   */
  private startAudio(uuid: string, media: 'audio' | 'video'): void {
    if (this.audioUuid !== null && this.audioUuid !== uuid && this.ownsSessionStill(this.audioUuid)) {
      logger.debug(`Audio session belongs to ${this.audioUuid}; not starting it for ${uuid}`);
      return;
    }
    const heldFor = this.audioUuid;
    this.clearHandoverTimer();
    this.audioUuid = uuid;
    // On Android the call's Telecom connection routes it, unless Telecom
    // refused the call and there is none. A session handed over with the
    // same media follows the new call's connection.
    const telecomCall = this.refused.has(uuid) ? undefined : uuid;
    this.withAudioRoutes('warn', (controller) => {
      if (heldFor !== null && heldFor !== uuid && this.audioMedia !== media) {
        logger.debug(`Session of ${heldFor} was started for ${String(this.audioMedia)}; restarting it for ${uuid} (${media})`);
        controller.stop();
      }
      controller.start(media, telecomCall);
      this.audioMedia = media;
    });
  }

  /**
   * Whether the session's owner keeps it against another call starting its
   * audio: it is live and not on hold. A call put on hold (Hold & Accept, a
   * swap) hands the session to the call that becomes active.
   */
  private ownsSessionStill(owner: string): boolean {
    if (!this.registry.isLive(owner)) {
      return false;
    }
    const call = this.registry.entryForUuid(owner)?.call;
    const held = this.wantHeld.get(owner) === true || (call ? getCallHoldState().isHeld(call) : false);
    return !held;
  }

  /** `uuid` is taking the session; see {@link audioClaims}. */
  private claimAudio(uuid: string): void {
    if (this.registry.isLive(uuid)) {
      this.audioClaims.add(uuid);
    }
  }

  /**
   * Releases the session the ending call owns; another call ending leaves it
   * alone.
   *
   * When the owner ends while another call is taking the session (answered,
   * placed or connected), the session is handed over rather than stopped:
   * that call takes it as it is when it starts its audio (see
   * {@link startAudio}). With End & Accept, CallKit sends the ending call's
   * endCall before the accepted call's answerCall, while it moves the session
   * from one to the other; incall-manager's stop() there would run
   * setActive:NO on the session CallKit is handing to the accepted call. So
   * while a call is only ringing, the session waits {@link HANDOVER_GRACE_MS}
   * for that answer, and is stopped if none comes: a ringing call isn't
   * taking it, and when it is answered later it starts a session of its own.
   * With no other live call it is stopped at once.
   */
  private releaseAudioIfOwnerEnded(): void {
    for (const uuid of [...this.audioClaims]) {
      if (!this.registry.isLive(uuid)) {
        this.audioClaims.delete(uuid);
      }
    }
    const owner = this.audioUuid;
    if (owner === null || this.registry.isLive(owner)) {
      this.clearHandoverTimer();
      return;
    }
    const others = this.registry.entries.filter(
      (entry) => entry.uuid !== owner && this.registry.isLive(entry.uuid)
    );
    const heir = others.find((entry) => this.audioClaims.has(entry.uuid));
    if (heir) {
      logger.debug(`Call ${owner} ended while ${heir.uuid} is taking the session; leaving it up for it`);
      this.clearHandoverTimer();
      // A connected call (the one on hold, say) inherits the session now:
      // nothing else will start it for that call. One still being answered
      // takes it when its own audio starts (see startAudio).
      if (heir.call?.status === 'connected') {
        this.audioUuid = heir.uuid;
        const media = this.audioMedia ?? 'audio';
        const telecomCall = this.refused.has(heir.uuid) ? undefined : heir.uuid;
        this.withAudioRoutes('debug', (controller) => controller.start(media, telecomCall));
      }
      return;
    }
    if (others.length > 0) {
      if (this.handoverTimer === null) {
        logger.debug(`Call ${owner} ended while another call rings; stopping its session unless that call is accepted`);
        this.handoverTimer = setTimeout(() => {
          this.handoverTimer = null;
          if (this.audioUuid === owner && !this.registry.isLive(owner)) {
            const taken = this.registry.entries.some(
              (entry) => this.audioClaims.has(entry.uuid) && this.registry.isLive(entry.uuid)
            );
            if (!taken) {
              this.stopAudio(owner);
            }
          }
        }, HANDOVER_GRACE_MS);
      }
      return;
    }
    this.stopAudio(owner);
  }

  /** Drops the hold state of calls that have ended. */
  private forgetEndedHolds(): void {
    for (const uuid of [...this.wantHeld.keys()]) {
      if (!this.registry.isLive(uuid)) {
        this.wantHeld.delete(uuid);
        const call = this.registry.entryForUuid(uuid)?.call;
        if (call) {
          getCallHoldState().forget(call);
        }
      }
    }
  }

  private clearHandoverTimer(): void {
    if (this.handoverTimer !== null) {
      clearTimeout(this.handoverTimer);
      this.handoverTimer = null;
    }
  }

  private stopAudio(uuid: string): void {
    if (uuid !== this.audioUuid) {
      return;
    }
    this.clearHandoverTimer();
    this.audioUuid = null;
    // incall-manager's stop() deactivates the session itself, and the
    // activation that stands now belonged to the call that is ending: the next
    // call waits for its own (or the fallback).
    this.setAudioSessionActive(false);
    this.audioMedia = null;
    this.withAudioRoutes('debug', (audio) => audio.stop());
  }

  /**
   * Runs `action` on the audio route controller. incall-manager is an
   * optional peer: when it isn't linked the controller can't be built
   * (`MissingPeerDependencyError`), and the call goes on without routing.
   */
  private withAudioRoutes(level: 'warn' | 'debug', action: (audio: AudioRouteController) => void): void {
    try {
      action(getAudioRouteController());
    } catch (error) {
      logger[level]('Audio routing unavailable:', error);
    }
  }

  private watchCallStatus(call: Call): void {
    // A native mute made before the call had a self participant.
    call.self$
      ?.pipe(filter(Boolean), take(1), takeUntil(this.destroyed$))
      .subscribe((participant) => {
        const uuid = this.registry.uuidForCall(call);
        const muted = uuid === undefined ? undefined : this.pendingMute.get(uuid);
        if (uuid === undefined || muted === undefined) {
          return;
        }
        this.pendingMute.delete(uuid);
        if (this.registry.isLive(uuid)) {
          this.applyMute(uuid, participant, muted);
        }
      });

    call.status$.pipe(takeUntil(this.destroyed$)).subscribe((status) => {
      const uuid = this.registry.uuidForCall(call);
      if (!uuid) {
        return;
      }
      if (status === 'connected') {
        logger.debug(`Call ${uuid} connected; starting the audio session`);
        this.registry.reportConnected(uuid);
        this.claimAudio(uuid);
        // Outbound calls never pass through the native answer handler, so this
        // is the only place their audio session gets started. Without it
        // InCallManager never runs for a call the user placed, and iOS leaves
        // the session in its default category — a connected but silent call.
        // `AudioRouteController.start` is idempotent, so an inbound call that
        // already started audio on answer is unaffected.
        void this.startAudioWhenSessionReady(uuid);
        return;
      }
      if (TERMINAL_STATUSES.has(status)) {
        // Ends the entry, which releases its audio if it owns the session.
        this.pendingMute.delete(uuid);
        this.registry.reportRemoteEnded(uuid);
      }
    });
  }

  private ensureTicking(): void {
    if (this.tickTimer) {
      return;
    }
    this.tickTimer = setInterval(() => {
      this.registry.tick();
      this.expireHeldActions();
      const pending = this.registry.entries.some((entry) => entry.state === 'pending-push');
      if (!pending && this.heldActions.size === 0) {
        this.stopTicking();
      }
    }, TICK_INTERVAL_MS);
  }

  private stopTicking(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /** A decline the native UI made: its call is already ended there. */
  private declineNatively(uuid: string): void {
    this.endingNatively = uuid.toLowerCase();
    try {
      this.registry.applyIntent(uuid, 'reject');
    } finally {
      this.endingNatively = null;
    }
  }

  /**
   * Ends the native call for the registry.
   *
   * A decline goes through callkeep's `rejectCall`: CallKit's end action on
   * iOS, `DisconnectCause.REJECTED` on Android. `reportEndCallWithUUID` has
   * no declined (or rejected) reason on either platform. A decline the native
   * UI made itself is already ended there, so it is not requested again.
   */
  private reportEnded(uuid: string, reason: CallEndReason): void {
    if (reason === 'declined') {
      if (this.endingNatively !== uuid && typeof RNCallKeep?.rejectCall === 'function') {
        RNCallKeep.rejectCall(uuid);
      }
      return;
    }
    RNCallKeep.reportEndCallWithUUID(uuid, this.endReasonFor(reason));
  }

  /**
   * callkeep's END_CALL_REASONS differ per platform, and so do the native
   * sides that read them. iOS: 1 failed, 2 remoteEnded, 3 unanswered,
   * 4 answeredElsewhere, 5 declinedElsewhere, and callkeep's MISSED is 2,
   * remoteEnded. Android: 1 ERROR, 2 REMOTE, 3 BUSY, 4 ANSWERED_ELSEWHERE,
   * 6 MISSED. So a missed call is UNANSWERED on iOS and MISSED on Android,
   * and a busy one UNANSWERED (BUSY on Android).
   * A local end keeps REMOTE_ENDED: neither table has a local reason, and
   * the native UI has usually ended the call already.
   */
  private endReasonFor(reason: Exclude<CallEndReason, 'declined'>): number {
    const reasons = requireCallKeep('native call UI').constants.END_CALL_REASONS;
    switch (reason) {
      case 'missed':
        return Platform.OS === 'ios' ? reasons.UNANSWERED : reasons.MISSED;
      case 'failed':
        return reasons.FAILED;
      case 'duplicate':
        return reasons.ANSWERED_ELSEWHERE;
      case 'busy':
        // UNANSWERED: iOS shows it as a call nobody answered; on Android the
        // same value (3) is DisconnectCause BUSY.
        return reasons.UNANSWERED;
      default:
        return reasons.REMOTE_ENDED;
    }
  }
}

function isRemovable(value: unknown): value is { remove(): void } {
  return typeof (value as { remove?: unknown } | null | undefined)?.remove === 'function';
}

/** callkeep hands Android handles URI-encoded (`%2B1555...`). */
function decodeHandle(handle: string | undefined): string | undefined {
  if (handle === undefined) {
    return undefined;
  }
  try {
    return decodeURIComponent(handle);
  } catch {
    return handle;
  }
}

/** How many calls may be live at once in each mode: one, or one plus one waiting or on hold. */
function callLimitFor(mode: CallWaitingMode): number {
  return mode === 'single' ? 1 : 2;
}

/** RFC 4122 v4 UUID. `crypto.getRandomValues` comes from the polyfills entry. */
function generateUuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Module-scope state is NOT process-wide here. tsup builds each subpath entry
 * (`.`, `./callkit`, `./audio`) as a self-contained bundle, so this module is
 * duplicated into `dist/index.*` AND `dist/callkit.*` — two copies, two
 * module scopes. With a `let singleton` the app entry's `setup()` ran on the
 * `/callkit` copy while the provider's registry lived on the root copy:
 * CallKit rang from one brain, answers landed in the other, and the audio
 * session was never coordinated — a connected call with no audio. Observed on
 * device as `uuid=<valid>, setup=false`. `globalThis` is the one scope every
 * copy shares.
 */
const CALLKIT_GLOBAL = CALLKIT_BRIDGE_KEY;

/** The process-wide CallKit bridge. Safe to call before React mounts. */
export function getCallKit(): CallKeepBridge {
  return processGlobal(CALLKIT_GLOBAL, () => new CallKeepBridge());
}

/** Test seam — drops the singleton. */
export function resetCallKitForTesting(): void {
  peekProcessGlobal<CallKeepBridge>(CALLKIT_GLOBAL)?.destroy();
  dropProcessGlobal(CALLKIT_GLOBAL);
}
