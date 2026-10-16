import { Platform } from 'react-native';
import RNCallKeep, { CONSTANTS } from 'react-native-callkeep';
import { EMPTY, of, Subject, switchMap, takeUntil } from 'rxjs';

import { getAudioRouteController } from '../audio/AudioRouteController';
import { logger } from '@signalwire/react';
import { CallInProgressError } from '../errors';
import { assertPeerModule } from '../platform/peers';
import { clearPendingVoipCall, getPendingVoipCall } from '../push/voipToken';
import { CallRegistry } from './CallRegistry';

import type { CallRegistryHost, PushPayload } from './types';

/** The `didDisplayIncomingCall` payload, which callkeep types loosely. */
interface DisplayEvent {
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

const TICK_INTERVAL_MS = 2000;
const AUDIO_SESSION_TIMEOUT_MS = 3000;
const HANDLE_TYPE = 'generic';

/** Runtime permissions callkeep's ConnectionService needs on Android. */
const ANDROID_CALL_PERMISSIONS = ['android.permission.READ_PHONE_NUMBERS'];

/** Call statuses after which the native entry must be torn down. */
// 'ended' is what the SDK actually reports — the wire shows call_state
// created -> answered -> ending -> ended, and none of the three names below
// ever appear. Without it a remote hangup never reached reportRemoteEnded, so
// the native entry outlived the call and the user had to end it by hand.
// The original three are kept: they cost nothing and this list is observed.
const TERMINAL_STATUSES = new Set<string>([
  'ended',
  'disconnected',
  'destroyed',
  'failed'
]);

export interface CallKitSetupOptions {
  appName: string;
  imageName?: string;
  ringtoneSound?: string;
  /** Whether the native UI offers a video button. Default `false`. */
  supportsVideo?: boolean;
  androidChannelId?: string;
  androidChannelName?: string;
  /** How long a push entry waits for its SDK call. Default 20000. */
  fusionTimeoutMs?: number;
}

const NATIVE_EVENTS = [
  'didDisplayIncomingCall',
  'answerCall',
  'endCall',
  'didPerformDTMFAction',
  'didToggleHoldCallAction',
  'didPerformSetMutedCallAction',
  'didActivateAudioSession',
  'didResetProvider',
  // Replays what fired before JavaScript existed. See handleLoadedEvents.
  'didLoadWithEvents'
] as const;

/**
 * Connects {@link CallRegistry} to `react-native-callkeep`.
 *
 * The only file in the package that imports callkeep. Lives at module scope as
 * a singleton because a VoIP push can wake the app before React mounts.
 */
export class CallKeepBridge {
  readonly registry: CallRegistry;

  private readonly destroyed$ = new Subject<void>();
  private supportsVideo = false;
  private isSetup = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private releaseAudioGate: (() => void) | null = null;
  /** Entry awaiting a bridge dial; see {@link beginBridgeDial}. */
  private pendingBridgeUuid: string | null = null;
  /**
   * The call the audio session was started for. There is one session per
   * app, so only this call may stop it, and it is released when this call
   * ends, by whichever path. See {@link startAudio}.
   */
  private audioUuid: string | null = null;

  constructor(options: { fusionTimeoutMs?: number } = {}) {
    const host: CallRegistryHost = {
      displayIncomingCall: (uuid, handle, displayName) =>
        RNCallKeep.displayIncomingCall(uuid, handle, displayName, HANDLE_TYPE, this.supportsVideo),
      startOutgoingCall: (uuid, handle, displayName) =>
        RNCallKeep.startCall(uuid, handle, displayName, HANDLE_TYPE, this.supportsVideo),
      reportOutgoingConnected: (uuid) => RNCallKeep.reportConnectedOutgoingCallWithUUID(uuid),
      reportCallEnded: (uuid, reason) =>
        RNCallKeep.reportEndCallWithUUID(uuid, this.endReasonFor(reason)),
      generateUuid: () => generateUuid(),
      now: () => Date.now()
    };

    this.registry = new CallRegistry({ host, fusionTimeoutMs: options.fusionTimeoutMs });

    // A call can end in the native UI, from the SDK, or in the registry
    // itself: the app's endCall (a failed bridge dial), or tick() expiring an
    // answered push. CallKit answers none of the registry's own reports with
    // an endCall action, so watching the entries is the one place that sees
    // every end. Without it a session started for such a call stayed up in the
    // idle app, and the next call's start was ignored.
    this.registry.entries$
      .pipe(takeUntil(this.destroyed$))
      .subscribe(() => this.releaseAudioIfOwnerEnded());

    // Registered here, not in setup(): callkeep flushes the events it buffered
    // while JavaScript was starting as soon as the bundle finishes loading,
    // which can be before an app gets around to calling setup(). A listener
    // added later receives nothing, and on a cold start that is every event
    // the call has had so far — the incoming-call display and the user's
    // answer both happen before React mounts.
    // Guarded: callkeep is an optional peer, and this runs in the constructor
    // — before setup() has had a chance to assert it is installed. An app that
    // only wants the SDK, with no native call UI, must not crash on import.
    if (typeof RNCallKeep?.addEventListener === 'function') {
      RNCallKeep.addEventListener('didLoadWithEvents', (events) =>
        this.handleLoadedEvents(events as LoadedEvent[])
      );
    }
  }

  /** Performs the native handshake. Call once, from the app entry file. */
  async setup(options: CallKitSetupOptions): Promise<void> {
    if (this.isSetup) {
      return;
    }

    assertPeerModule(
      RNCallKeep as unknown as object | undefined,
      'react-native-callkeep',
      'native call UI',
      'setup'
    );

    this.supportsVideo = options.supportsVideo ?? false;

    await RNCallKeep.setup({
      ios: {
        appName: options.appName,
        imageName: options.imageName,
        ringtoneSound: options.ringtoneSound,
        supportsVideo: this.supportsVideo,
        maximumCallGroups: '1',
        maximumCallsPerCallGroup: '1'
      },
      android: {
        alertTitle: 'Permissions required',
        alertDescription: `${options.appName} needs permission to manage phone calls.`,
        cancelButton: 'Cancel',
        okButton: 'OK',
        imageName: options.imageName,
        // Requested at runtime, not merely declared. callkeep's
        // ConnectionService calls TelecomManager.getPhoneAccount() while
        // building an outgoing connection, and that needs READ_PHONE_NUMBERS
        // — a dangerous permission, so the manifest entry callkeep ships is
        // not enough. Ungranted, the call connects and then the *app* dies:
        //
        //   FATAL EXCEPTION: main
        //   SecurityException: Neither user nor current process has
        //   android.permission.READ_PHONE_NUMBERS
        //     at VoiceConnectionService.createConnection
        //
        // which looks like a crash on answer rather than a missing grant.
        additionalPermissions: ANDROID_CALL_PERMISSIONS,
        selfManaged: true,
        foregroundService: {
          channelId: options.androidChannelId ?? 'signalwire-calls',
          channelName: options.androidChannelName ?? 'Ongoing calls',
          notificationTitle: 'Call in progress'
        }
      }
    } as never);

    RNCallKeep.setAvailable(true);
    this.registerNativeListeners();
    this.isSetup = true;
    await this.adoptPendingNativeCall();
    logger.debug('CallKit ready');
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
   */
  bindClient(client: SignalWire): void {
    const connected$ = client.isConnected$ ?? of(true);

    connected$
      .pipe(
        switchMap(() => client.session?.incomingCalls$ ?? EMPTY),
        takeUntil(this.destroyed$)
      )
      .subscribe((calls) => {
        for (const call of calls) {
          if (!this.registry.uuidForCall(call)) {
            this.registry.attachIncomingCall(call);
            this.watchCallStatus(call);
          }
        }
      });
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
  answerIncomingFromApp(call: Call): boolean {
    const uuid = this.registry.uuidForCall(call);
    if (!uuid || !this.isSetup) {
      // The fallback is the silent-call trap, so a decline must say why.
      logger.debug(
        `In-app answer NOT routed through CallKit (uuid=${String(uuid)}, setup=${this.isSetup}); answering the SDK directly`
      );
      return false;
    }
    logger.debug(`In-app answer routed through CallKit for ${uuid}`);
    RNCallKeep.answerIncomingCall(uuid);
    return true;
  }

  /** The reject twin of {@link answerIncomingFromApp}. */
  rejectIncomingFromApp(call: Call): boolean {
    const uuid = this.registry.uuidForCall(call);
    if (!uuid || !this.isSetup) {
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
   * Brings the app to the front, for a call the OS will not show.
   *
   * Android wakes a killed app into a headless task to handle the push, so
   * JavaScript runs but no activity does — and with a self-managed
   * ConnectionService the system draws nothing either. Telecom ends up
   * holding a live connection that the user cannot see or answer.
   *
   * iOS never needs this: CallKit puts its own screen up, over the lock
   * screen if it has to.
   */
  bringToForeground(): void {
    if (Platform.OS !== 'android' || typeof RNCallKeep?.backToForeground !== 'function') {
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
    const live = this.registry.entries.find((entry) => this.registry.isLive(entry.uuid));
    if (live) {
      throw new CallInProgressError(live.uuid);
    }
  }

  /**
   * Registers an outbound call with the native UI. Returns its UUID.
   *
   * A second call while another is live (one that got past
   * {@link assertCanDial}, such as two dials racing) is hung up and refused
   * with {@link CallInProgressError}: CallKit would refuse its start
   * transaction, and the registry must not hold a call CallKit never took.
   */
  trackCall(call: Call, handle: string, displayName: string): string {
    const claimed = this.pendingBridgeUuid;
    if (claimed !== null) {
      this.pendingBridgeUuid = null;
      if (this.bindBridgeCall(claimed, call)) {
        logger.debug(`Adopted bridge call ${call.id} into existing entry ${claimed}`);
        return claimed;
      }
      if (this.registry.entryForUuid(claimed)?.state === 'pending-push') {
        // The user ended the answered push while this call was being placed.
        // They have hung up: no second native call, and nothing left live.
        logger.debug(`Entry ${claimed} was ended by the user during the bridge dial; hanging up`);
        void call.hangup().catch((error: unknown) => {
          logger.debug('Hangup of the abandoned bridge call failed:', error);
        });
        return claimed;
      }
      // The entry died while we were dialling. Fall through and report a
      // normal outbound call, so the user is not left on a live call with no
      // native UI to end it.
      logger.debug(`Entry ${claimed} vanished during the bridge dial`);
    }

    const tracked = this.registry.uuidForCall(call);
    if (tracked) {
      return tracked;
    }
    const live = this.registry.entries.find((entry) => this.registry.isLive(entry.uuid));
    if (live) {
      logger.warn(`Refusing outbound call ${call.id}: ${live.uuid} is still live; hanging it up`);
      void call.hangup().catch((error: unknown) => {
        logger.debug('Hangup of the refused second call failed:', error);
      });
      throw new CallInProgressError(live.uuid);
    }

    const uuid = this.registry.attachOutgoingCall(call, handle, displayName);
    this.watchCallStatus(call);
    // Deliberate breadcrumb: RNCallKeep's own logs are NSLog-only, invisible in
    // Metro when launched outside Xcode, so without this line the entire
    // outbound CallKit path is indistinguishable from never having run.
    logger.debug(`Tracking outbound call ${uuid} for ${handle}`);
    return uuid;
  }

  destroy(): void {
    this.destroyed$.next();
    this.destroyed$.complete();
    this.stopTicking();
    if (this.audioUuid !== null) {
      this.stopAudio(this.audioUuid);
    }
    for (const event of NATIVE_EVENTS) {
      RNCallKeep.removeEventListener(event);
    }
    this.registry.destroy();
    this.isSetup = false;
  }

  // ---------------------------------------------------------------- internals

  private registerNativeListeners(): void {
    // A VoIP push is reported to CallKit natively, before JavaScript exists.
    // This is how the registry learns about a call that is already ringing:
    // without it the entry is created only when the app happens to be running,
    // and a cold-start answer has nothing to apply an intent to.
    RNCallKeep.addEventListener(
      'didDisplayIncomingCall',
      // callkeep types `payload` as bare `object`, so it is narrowed below
      // rather than in the parameter list.
      (event) => this.handleDidDisplayIncomingCall(event as DisplayEvent)
    );

    RNCallKeep.addEventListener('answerCall', ({ callUUID }: { callUUID: string }) =>
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
  private async adoptPendingNativeCall(): Promise<void> {
    const pending = await getPendingVoipCall();
    if (!pending?.uuid) {
      return;
    }
    if (this.registry.entryForUuid(pending.uuid)) {
      return;
    }

    const { uuid, callId, handle, callerName, ...rest } = pending;
    const data: Record<string, string> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (typeof value === 'string') {
        data[key] = value;
      }
    }

    logger.debug(`Adopting pending native call ${uuid} from the launch push`);
    this.registry.adoptNativeEntry({
      uuid,
      callId: callId && callId.length > 0 ? callId : undefined,
      from: handle ?? 'Unknown',
      fromName: callerName ?? 'Incoming call',
      data: Object.keys(data).length > 0 ? data : undefined
    });
    this.ensureTicking();
    await clearPendingVoipCall();
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
        this.handleAnswerCall((event.data as { callUUID: string }).callUUID);
      } else if (event?.name === 'RNCallKeepPerformEndCallAction') {
        this.handleEndCall((event.data as { callUUID: string }).callUUID);
      }
    }
  }

  private handleAnswerCall(callUUID: string): void {
    logger.debug(`Native answer for ${callUUID}`);
    // Applied synchronously — the registry buffers it when the SDK call has
    // not arrived yet. Only the audio start waits for the audio session.
    this.registry.applyIntent(callUUID, 'answer');
    void this.startAudioWhenSessionReady(callUUID);
  }

  /** Audio, if this call owns it, is released by {@link releaseAudioIfOwnerEnded}. */
  private handleEndCall(callUUID: string): void {
    logger.debug(`Native end for ${callUUID}`);
    const entry = this.registry.entryForUuid(callUUID);
    if (entry?.state === 'pending-push') {
      this.registry.applyIntent(callUUID, 'reject');
      return;
    }
    this.registry.endCall(callUUID);
  }

  private handleDidDisplayIncomingCall(event: DisplayEvent): void {
    {
      const { callUUID, handle, localizedCallerName, fromPushKit, payload } = event;
        const fields = (payload ?? {}) as Record<string, unknown>;
        if (fromPushKit !== '1') {
          return;
        }
        const data: Record<string, string> = {};
        for (const [key, value] of Object.entries(fields)) {
          if (key !== 'callId' && typeof value === 'string') {
            data[key] = value;
          }
        }
        const callId = typeof fields.callId === 'string' ? fields.callId : undefined;
        logger.debug(`Native push displayed ${callUUID}`);
        this.registry.adoptNativeEntry({
          uuid: callUUID,
          callId: callId && callId.length > 0 ? callId : undefined,
          from: handle,
          fromName: localizedCallerName,
          data: Object.keys(data).length > 0 ? data : undefined
        });
        this.ensureTicking();
    }
  }

  private registerRemainingListeners(): void {
    RNCallKeep.addEventListener('endCall', ({ callUUID }: { callUUID: string }) =>
      this.handleEndCall(callUUID)
    );

    RNCallKeep.addEventListener(
      'didPerformDTMFAction',
      ({ callUUID, digits }: { callUUID: string; digits: string }) => {
        void this.registry.entryForUuid(callUUID)?.call?.sendDigits(digits);
      }
    );

    RNCallKeep.addEventListener('didToggleHoldCallAction', ({ callUUID }: { callUUID: string }) => {
      void this.registry.entryForUuid(callUUID)?.call?.toggleHold();
    });

    RNCallKeep.addEventListener(
      'didPerformSetMutedCallAction',
      ({ callUUID, muted }: { callUUID: string; muted: boolean }) => {
        const participant = this.registry.entryForUuid(callUUID)?.call?.self;
        if (!participant) {
          return;
        }
        void (muted ? participant.mute() : participant.unmute());
      }
    );

    // iOS only. Starting media before this fires yields a silent call.
    RNCallKeep.addEventListener('didActivateAudioSession', () => {
      logger.debug('Audio session activated');
      this.releaseAudioGate?.();
      this.releaseAudioGate = null;
    });

    // A provider reset ends every call and its session.
    RNCallKeep.addEventListener('didResetProvider', () => this.handleProviderReset());
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
  }

  /**
   * Starts the audio route once CallKit activates the audio session, for a
   * call that is still live by then.
   *
   * Starting media before `didActivateAudioSession` yields a connected but
   * silent call on iOS. Android has no such event, so this runs immediately.
   * The timeout prevents a permanently silent call if the event never fires.
   */
  private async startAudioWhenSessionReady(uuid: string): Promise<void> {
    if (Platform.OS === 'ios') {
      const gate = new Promise<void>((resolve) => {
        this.releaseAudioGate = resolve;
      });
      await Promise.race([
        gate,
        new Promise<void>((resolve) => setTimeout(resolve, AUDIO_SESSION_TIMEOUT_MS))
      ]);
    }
    // The call can end during the wait, including a push the user ended
    // before its SDK call existed. Started anyway, the session would stay up
    // with nothing left to stop it.
    if (!this.registry.isLive(uuid)) {
      logger.debug(`Call ${uuid} ended before its audio session was ready; not starting audio`);
      return;
    }
    this.startAudio(uuid);
  }

  /**
   * Starts the session for `uuid`, which then owns it. While another live
   * call owns it (a call waiting behind it was answered), the session is left
   * as it is: `AudioRouteController.start` is first-wins either way. A
   * session handed over by an ended owner (see
   * {@link releaseAudioIfOwnerEnded}) is taken as it is, with the route and
   * mode the ended call left.
   */
  private startAudio(uuid: string): void {
    if (this.audioUuid !== null && this.audioUuid !== uuid && this.registry.isLive(this.audioUuid)) {
      logger.debug(`Audio session belongs to ${this.audioUuid}; not starting it for ${uuid}`);
      return;
    }
    this.audioUuid = uuid;
    try {
      getAudioRouteController().start(this.supportsVideo ? 'video' : 'audio');
    } catch (error) {
      logger.warn('Audio routing unavailable:', error);
    }
  }

  /**
   * Releases the session the ending call owns; another call ending leaves it
   * alone.
   *
   * While another call is live, the ended owner's session is handed over
   * rather than stopped: the next call to start audio takes it as it is, and
   * it is stopped once no live call is left. With End & Accept, CallKit sends
   * the ending call's endCall before the accepted call's answerCall, while it
   * moves the session from one to the other. incall-manager's stop() there
   * would run setActive:NO on the session CallKit is handing to the accepted
   * call; CallKit deactivates it itself if it has to (didDeactivateAudioSession).
   */
  private releaseAudioIfOwnerEnded(): void {
    const owner = this.audioUuid;
    if (owner === null || this.registry.isLive(owner)) {
      return;
    }
    const next = this.registry.entries.find(
      (entry) => entry.uuid !== owner && this.registry.isLive(entry.uuid)
    );
    if (next) {
      logger.debug(`Call ${owner} ended while ${next.uuid} is live; leaving the session up for it`);
      return;
    }
    this.stopAudio(owner);
  }

  private stopAudio(uuid: string): void {
    if (uuid !== this.audioUuid) {
      return;
    }
    this.audioUuid = null;
    try {
      getAudioRouteController().stop();
    } catch (error) {
      logger.debug('Audio routing unavailable on stop:', error);
    }
  }

  private watchCallStatus(call: Call): void {
    call.status$.pipe(takeUntil(this.destroyed$)).subscribe((status) => {
      const uuid = this.registry.uuidForCall(call);
      if (!uuid) {
        return;
      }
      if (status === 'connected') {
        logger.debug(`Call ${uuid} connected; starting the audio session`);
        this.registry.reportConnected(uuid);
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
      const pending = this.registry.entries.some((entry) => entry.state === 'pending-push');
      if (!pending) {
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

  private endReasonFor(reason: 'missed' | 'remote' | 'local'): number {
    const reasons = CONSTANTS.END_CALL_REASONS;
    return reason === 'missed' ? reasons.MISSED : reasons.REMOTE_ENDED;
  }
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
const CALLKIT_GLOBAL = '__signalwireRNCallKitBridge';

type CallKitHolder = { [CALLKIT_GLOBAL]?: CallKeepBridge };

/** The process-wide CallKit bridge. Safe to call before React mounts. */
export function getCallKit(): CallKeepBridge {
  const holder = globalThis as CallKitHolder;
  holder[CALLKIT_GLOBAL] ??= new CallKeepBridge();
  return holder[CALLKIT_GLOBAL];
}

/** Test seam — drops the singleton. */
export function resetCallKitForTesting(): void {
  const holder = globalThis as CallKitHolder;
  holder[CALLKIT_GLOBAL]?.destroy();
  delete holder[CALLKIT_GLOBAL];
}
