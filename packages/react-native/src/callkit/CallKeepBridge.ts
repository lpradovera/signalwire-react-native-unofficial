import { Platform } from 'react-native';
import RNCallKeep, { CONSTANTS } from 'react-native-callkeep';
import {
  BehaviorSubject,
  EMPTY,
  filter,
  finalize,
  firstValueFrom,
  of,
  Subject,
  switchMap,
  takeUntil,
  timeout
} from 'rxjs';

import { getAudioRouteController } from '../audio/AudioRouteController';
import { logger } from '@signalwire/react';
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
import type { Subscription } from 'rxjs';

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
  /**
   * Whether CallKit has the audio session active, from its activate and
   * deactivate events. Kept as state, not as a one-shot gate: for an outbound
   * call CallKit activates the session when the start-call action is
   * fulfilled, before the call connects, so a gate created at `connected`
   * would wait for an event that has already fired.
   */
  private readonly audioSessionActive$ = new BehaviorSubject(false);
  /**
   * What each addEventListener returned. destroy() removes these, and only
   * these: callkeep's removeEventListener(type) with no handler removes every
   * handler of that type in the process, the app's own included.
   */
  private readonly nativeListeners: Array<{ remove(): void }> = [];
  /**
   * Replayed answers and ends for a uuid the registry doesn't know yet. The
   * replay can reach JS before setup() adopts the cached launch push (see
   * handleLoadedEvents); they are applied when that entry is adopted.
   */
  private readonly deferredReplay = new Map<string, Array<'answer' | 'end'>>();
  /** The clients whose inbound calls are mirrored; see {@link bindClient}. */
  private readonly boundClients = new Map<SignalWire, Subscription>();
  /** Entry awaiting a bridge dial; see {@link beginBridgeDial}. */
  private pendingBridgeUuid: string | null = null;
  /**
   * SDK inbound calls. The registry answers every one of them audio-only
   * (`answer({ audio: true, video: false })`, an in-app answer included,
   * since that is routed through CallKit), so they are voice calls whatever
   * their offer carried. See {@link mediaFor}.
   */
  private readonly inboundCalls = new WeakSet<Call>();
  /**
   * The call the audio session was started for. There is one session per
   * app, so only this call may stop it, and it is released when this call
   * ends, by whichever path. See {@link startAudio}.
   */
  private audioUuid: string | null = null;

  constructor(options: { fusionTimeoutMs?: number } = {}) {
    const host: CallRegistryHost = {
      // The registry writes the entry before it calls the host, so the call (if
      // there is one yet) is there to read its media from.
      displayIncomingCall: (uuid, handle, displayName) =>
        RNCallKeep.displayIncomingCall(uuid, handle, displayName, HANDLE_TYPE, this.reportsVideo(uuid)),
      startOutgoingCall: (uuid, handle, displayName) =>
        RNCallKeep.startCall(uuid, handle, displayName, HANDLE_TYPE, this.reportsVideo(uuid)),
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
      this.keep(
        RNCallKeep.addEventListener('didLoadWithEvents', (events) =>
          this.handleLoadedEvents(events as LoadedEvent[])
        )
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
   *
   * Binding a client that is already bound does nothing. Returns the unbind:
   * after it, the client's inbound calls no longer reach CallKit (the
   * provider calls it when `callKit` is turned off).
   */
  bindClient(client: SignalWire): () => void {
    const existing = this.boundClients.get(client);
    if (existing) {
      return () => existing.unsubscribe();
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
            this.registry.attachIncomingCall(call);
            this.watchCallStatus(call);
          }
        }
      });
    if (!subscription.closed) {
      this.boundClients.set(client, subscription);
    }
    return () => subscription.unsubscribe();
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
   * Registers an outbound call with the native UI. Returns its UUID.
   *
   * Whether it is a video call comes from the call itself
   * (`call.mediaDirections`, the SDK's own offer, after preferences,
   * `?channel=`, the dial options and a disabled camera are all applied): a
   * voice call starts on the receiver (or a connected headset or car), a video
   * call on the loudspeaker. A call without `mediaDirections` falls back to
   * the app's `supportsVideo`.
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
    for (const listener of this.nativeListeners.splice(0)) {
      listener.remove();
    }
    this.deferredReplay.clear();
    this.registry.destroy();
    this.isSetup = false;
  }

  // ---------------------------------------------------------------- internals

  /** Keeps an addEventListener result for destroy(); see {@link nativeListeners}. */
  private keep(listener: unknown): void {
    if (typeof (listener as { remove?: unknown } | undefined)?.remove === 'function') {
      this.nativeListeners.push(listener as { remove(): void });
    }
  }

  private registerNativeListeners(): void {
    // A VoIP push is reported to CallKit natively, before JavaScript exists.
    // This is how the registry learns about a call that is already ringing:
    // without it the entry is created only when the app happens to be running,
    // and a cold-start answer has nothing to apply an intent to.
    this.keep(
      RNCallKeep.addEventListener(
        'didDisplayIncomingCall',
        // callkeep types `payload` as bare `object`, so it is narrowed below
        // rather than in the parameter list.
        (event) => this.handleDidDisplayIncomingCall(event as DisplayEvent)
      )
    );

    this.keep(
      RNCallKeep.addEventListener('answerCall', ({ callUUID }: { callUUID: string }) =>
        this.handleAnswerCall(callUUID)
      )
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
    this.applyDeferredReplay(uuid);
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
        this.replayAction((event.data as { callUUID: string }).callUUID, 'answer');
      } else if (event?.name === 'RNCallKeepPerformEndCallAction') {
        this.replayAction((event.data as { callUUID: string }).callUUID, 'end');
      } else if (event?.name === 'RNCallKeepDidActivateAudioSession') {
        this.setAudioSessionActive(true);
      } else if (event?.name === 'RNCallKeepDidDeactivateAudioSession') {
        this.setAudioSessionActive(false);
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
      this.runReplayed(uuid, action);
      return;
    }
    logger.debug(`Holding the replayed ${action} for ${uuid} until its entry is adopted`);
    this.deferredReplay.set(uuid, [...(this.deferredReplay.get(uuid) ?? []), action]);
  }

  private applyDeferredReplay(uuid: string): void {
    const actions = this.deferredReplay.get(uuid);
    if (!actions) {
      return;
    }
    this.deferredReplay.delete(uuid);
    for (const action of actions) {
      this.runReplayed(uuid, action);
    }
  }

  private runReplayed(uuid: string, action: 'answer' | 'end'): void {
    if (action === 'answer') {
      this.handleAnswerCall(uuid);
    } else {
      this.handleEndCall(uuid);
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
        this.applyDeferredReplay(callUUID);
    }
  }

  private registerRemainingListeners(): void {
    this.keep(
      RNCallKeep.addEventListener('endCall', ({ callUUID }: { callUUID: string }) =>
        this.handleEndCall(callUUID)
      )
    );

    this.keep(
      RNCallKeep.addEventListener(
        'didPerformDTMFAction',
        ({ callUUID, digits }: { callUUID: string; digits: string }) => {
          void this.registry.entryForUuid(callUUID)?.call?.sendDigits(digits);
        }
      )
    );

    this.keep(
      RNCallKeep.addEventListener('didToggleHoldCallAction', ({ callUUID }: { callUUID: string }) => {
        void this.registry.entryForUuid(callUUID)?.call?.toggleHold();
      })
    );

    this.keep(
      RNCallKeep.addEventListener(
        'didPerformSetMutedCallAction',
        ({ callUUID, muted }: { callUUID: string; muted: boolean }) => {
          const participant = this.registry.entryForUuid(callUUID)?.call?.self;
          if (!participant) {
            return;
          }
          void (muted ? participant.mute() : participant.unmute());
        }
      )
    );

    // iOS only. Starting media before this fires yields a silent call.
    this.keep(
      RNCallKeep.addEventListener('didActivateAudioSession', () => {
        logger.debug('Audio session activated');
        this.setAudioSessionActive(true);
      })
    );

    this.keep(
      RNCallKeep.addEventListener('didDeactivateAudioSession', () => {
        logger.debug('Audio session deactivated');
        this.setAudioSessionActive(false);
      })
    );

    // A provider reset ends every call and its session, with no deactivation
    // event of its own.
    this.keep(
      RNCallKeep.addEventListener('didResetProvider', () => {
        logger.debug('CallKit provider reset');
        this.setAudioSessionActive(false);
      })
    );
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
          timeout({ first: AUDIO_SESSION_TIMEOUT_MS, with: () => of(true) }),
          takeUntil(this.destroyed$)
        ),
        { defaultValue: false }
      );
    }
    // The call can end during the wait. Started anyway, the session would stay
    // up with nothing left to stop it, and the next call, whose own start is
    // ignored because start() is first-wins, would inherit this call's mode.
    // A push the user ended before its SDK call existed is over too.
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
   * A call's media. An SDK inbound call is voice: the registry answers it
   * audio-only. Its `mediaDirections` can't be used, because @signalwire/js
   * reports video for any offer whose m=video sends ('sendrecv' before the
   * answer, 'recvonly' after it), so a video caller's call would start on the
   * loudspeaker. An outbound call (the bridge call placed for a push
   * included) is video when it sends or receives video; one without
   * `mediaDirections`, or a destroyed one, uses the app's `supportsVideo`. A
   * pushed entry whose call hasn't arrived yet is shown as voice, as iOS shows
   * every VoIP push: its call is answered audio-only, or is the app's own
   * bridge call, whose type is shown once it binds.
   */
  private mediaFor(call: Call | null | undefined): 'audio' | 'video' {
    if (!call || this.inboundCalls.has(call)) {
      return 'audio';
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
      return this.supportsVideo ? 'video' : 'audio';
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
   */
  private showBoundCallType(uuid: string): void {
    const entry = this.registry.entryForUuid(uuid);
    if (Platform.OS !== 'ios' || !entry || !this.reportsVideo(uuid)) {
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
   */
  private startAudio(uuid: string, media: 'audio' | 'video'): void {
    if (this.audioUuid !== null && this.audioUuid !== uuid) {
      logger.debug(`Audio session belongs to ${this.audioUuid}; not starting it for ${uuid}`);
      return;
    }
    this.audioUuid = uuid;
    try {
      getAudioRouteController().start(media);
    } catch (error) {
      logger.warn('Audio routing unavailable:', error);
    }
  }

  /** Releases the session the ending call owns; another call ending leaves it alone. */
  private releaseAudioIfOwnerEnded(): void {
    if (this.audioUuid !== null && !this.registry.isLive(this.audioUuid)) {
      this.stopAudio(this.audioUuid);
    }
  }

  private stopAudio(uuid: string): void {
    if (uuid !== this.audioUuid) {
      return;
    }
    this.audioUuid = null;
    // incall-manager's stop() deactivates the session itself, and the
    // activation that stands now belonged to the call that is ending: the next
    // call waits for its own (or the fallback).
    this.setAudioSessionActive(false);
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
