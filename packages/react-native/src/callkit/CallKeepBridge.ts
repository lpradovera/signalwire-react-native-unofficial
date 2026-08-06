import { Platform } from 'react-native';
import RNCallKeep, { CONSTANTS } from 'react-native-callkeep';
import { EMPTY, of, Subject, switchMap, takeUntil } from 'rxjs';

import { getAudioRouteController } from '../audio/AudioRouteController';
import { logger } from '@signalwire/react';
import { assertPeerModule } from '../platform/peers';
import { CallRegistry } from './CallRegistry';

import type { CallRegistryHost, PushPayload } from './types';
import type { Call, SignalWire } from '@signalwire/js';

const TICK_INTERVAL_MS = 2000;
const AUDIO_SESSION_TIMEOUT_MS = 3000;
const HANDLE_TYPE = 'generic';

/** Call statuses after which the native entry must be torn down. */
const TERMINAL_STATUSES = new Set<string>(['disconnected', 'destroyed', 'failed']);

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
  'answerCall',
  'endCall',
  'didPerformDTMFAction',
  'didToggleHoldCallAction',
  'didPerformSetMutedCallAction',
  'didActivateAudioSession'
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
        additionalPermissions: [],
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

  /** Registers an outbound call with the native UI. Returns its UUID. */
  trackCall(call: Call, handle: string, displayName: string): string {
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
    for (const event of NATIVE_EVENTS) {
      RNCallKeep.removeEventListener(event);
    }
    this.registry.destroy();
    this.isSetup = false;
  }

  // ---------------------------------------------------------------- internals

  private registerNativeListeners(): void {
    RNCallKeep.addEventListener('answerCall', ({ callUUID }: { callUUID: string }) => {
      logger.debug(`Native answer for ${callUUID}`);
      // Applied synchronously — the registry buffers it when the SDK call has
      // not arrived yet. Only the audio start waits for the audio session.
      this.registry.applyIntent(callUUID, 'answer');
      void this.startAudioWhenSessionReady();
    });

    RNCallKeep.addEventListener('endCall', ({ callUUID }: { callUUID: string }) => {
      logger.debug(`Native end for ${callUUID}`);
      const entry = this.registry.entryForUuid(callUUID);
      if (entry?.state === 'pending-push') {
        this.registry.applyIntent(callUUID, 'reject');
        return;
      }
      this.registry.endCall(callUUID);
      this.stopAudio();
    });

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
  }

  /**
   * Starts the audio route once CallKit activates the audio session.
   *
   * Starting media before `didActivateAudioSession` yields a connected but
   * silent call on iOS. Android has no such event, so this runs immediately.
   * The timeout prevents a permanently silent call if the event never fires.
   */
  private async startAudioWhenSessionReady(): Promise<void> {
    if (Platform.OS === 'ios') {
      const gate = new Promise<void>((resolve) => {
        this.releaseAudioGate = resolve;
      });
      await Promise.race([
        gate,
        new Promise<void>((resolve) => setTimeout(resolve, AUDIO_SESSION_TIMEOUT_MS))
      ]);
    }
    this.startAudio();
  }

  private startAudio(): void {
    try {
      getAudioRouteController().start(this.supportsVideo ? 'video' : 'audio');
    } catch (error) {
      logger.warn('Audio routing unavailable:', error);
    }
  }

  private stopAudio(): void {
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
        void this.startAudioWhenSessionReady();
        return;
      }
      if (TERMINAL_STATUSES.has(status)) {
        this.registry.reportRemoteEnded(uuid);
        this.stopAudio();
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

let singleton: CallKeepBridge | null = null;

/** The process-wide CallKit bridge. Safe to call before React mounts. */
export function getCallKit(): CallKeepBridge {
  singleton ??= new CallKeepBridge();
  return singleton;
}

/** Test seam — drops the singleton. */
export function resetCallKitForTesting(): void {
  singleton?.destroy();
  singleton = null;
}
