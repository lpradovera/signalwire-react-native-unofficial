import { BehaviorSubject, Subject } from 'rxjs';

import { logger } from '@signalwire/react';

import type {
  CallEntry,
  CallIntent,
  CallRegistryHost,
  CallRegistryOptions,
  PushPayload
} from './types';
import type { Call } from '@signalwire/js';
import type { Observable } from 'rxjs';

const DEFAULT_FUSION_TIMEOUT_MS = 20_000;
const UNKNOWN_HANDLE = 'Unknown';
const UNKNOWN_NAME = 'Unknown caller';

/**
 * Reconciles native call UI entries with SDK calls.
 *
 * Entries arrive from two directions — a VoIP push, which lands before the SDK
 * is even connected, and the SDK itself — and this class fuses them into a
 * single identity. It holds no native imports and owns no timers; the host
 * supplies both, which keeps the state machine deterministic under test.
 */
export class CallRegistry {
  private readonly host: CallRegistryHost;
  private readonly fusionTimeoutMs: number;
  private readonly _entries$ = new BehaviorSubject<CallEntry[]>([]);
  private readonly _answered$ = new Subject<Call>();
  private readonly _answerRequested$ = new Subject<CallEntry>();
  private readonly byUuid = new Map<string, CallEntry>();

  constructor(options: CallRegistryOptions) {
    this.host = options.host;
    this.fusionTimeoutMs = options.fusionTimeoutMs ?? DEFAULT_FUSION_TIMEOUT_MS;
  }

  get entries$(): Observable<CallEntry[]> {
    return this._entries$.asObservable();
  }

  /**
   * Emits each call the moment it is answered through the native UI.
   *
   * This is how a native answer reaches the app's own screens. Without it,
   * tapping CallKit's Accept connects the call — audio and all — while the
   * React tree never learns: `activeCall` stays null, no call screen appears,
   * and the accept button looks like it did nothing.
   */
  get answered$(): Observable<Call> {
    return this._answered$.asObservable();
  }

  /**
   * Emits when the user accepts a push entry that has no SDK call yet.
   *
   * The fusion model assumes the call is on its way to us — the server dials
   * the subscriber and we wait. A bridge flow inverts that: the caller is
   * parked on ringback and *we* place the call that joins them, so nothing
   * will ever arrive to fuse with and the buffered intent would sit there
   * until the entry timed out as missed.
   *
   * Subscribe to place that call, then hand it back with {@link bindCall} so
   * it lands on the same native entry the user is already looking at.
   */
  get answerRequested$(): Observable<CallEntry> {
    return this._answerRequested$.asObservable();
  }

  get entries(): CallEntry[] {
    return this._entries$.value;
  }

  entryForUuid(uuid: string): CallEntry | undefined {
    return this.byUuid.get(uuid);
  }

  uuidForCall(call: Call): string | undefined {
    for (const entry of this.byUuid.values()) {
      if (entry.call === call) {
        return entry.uuid;
      }
    }
    return undefined;
  }

  /**
   * Reports a VoIP push to the native call UI immediately.
   *
   * Returns the UUID identifying the call for every later native callback.
   * A duplicate push for a call id already pending returns the original UUID.
   */
  reportIncomingPush(payload: PushPayload): string {
    if (payload.callId) {
      const existing = this.findPending((entry) => entry.expectedCallId === payload.callId);
      if (existing) {
        logger.debug(`Duplicate push for call ${payload.callId}, reusing ${existing.uuid}`);
        return existing.uuid;
      }
    } else {
      logger.warn(
        'Push payload has no callId. Fusion will fall back to matching a single ' +
          'unmatched inbound call, which is unreliable with concurrent calls. ' +
          'Expected if you bridge to a parked caller instead: no call is coming ' +
          'to fuse with — subscribe to answerRequested$ and bind the call you place.'
      );
    }

    const uuid = this.host.generateUuid();
    const handle = payload.from ?? UNKNOWN_HANDLE;
    const displayName = payload.fromName ?? UNKNOWN_NAME;

    this.write({
      uuid,
      state: 'pending-push',
      expectedCallId: payload.callId ?? null,
      call: null,
      handle,
      displayName,
      intent: null,
      data: payload.data,
      fuseDeadline: this.host.now() + this.fusionTimeoutMs
    });

    this.host.displayIncomingCall(uuid, handle, displayName);
    return uuid;
  }

  /** Fuses an inbound SDK call with a pending push, or creates a new entry. */
  attachIncomingCall(call: Call): void {
    if (this.uuidForCall(call)) {
      return;
    }

    const pending = this.findFusionTarget(call.id);
    if (pending) {
      this.fuse(pending, call);
      return;
    }

    const uuid = this.host.generateUuid();
    const handle = call.from ?? UNKNOWN_HANDLE;
    const displayName = call.fromName ?? UNKNOWN_NAME;

    this.write({
      uuid,
      state: 'fused',
      expectedCallId: call.id,
      call,
      handle,
      displayName,
      intent: null,
      fuseDeadline: null
    });

    this.host.displayIncomingCall(uuid, handle, displayName);
  }

  /** Registers an outbound call and starts the native outgoing call UI. */
  attachOutgoingCall(call: Call, handle: string, displayName: string): string {
    const existing = this.uuidForCall(call);
    if (existing) {
      return existing;
    }

    const uuid = this.host.generateUuid();
    this.write({
      uuid,
      state: 'fused',
      expectedCallId: call.id,
      call,
      handle,
      displayName,
      intent: null,
      fuseDeadline: null
    });

    this.host.startOutgoingCall(uuid, handle, displayName);
    return uuid;
  }

  /**
   * Attaches a call to an entry that already exists, keeping its UUID.
   *
   * For the bridge flow: the user answered a push, we dialled to join them to
   * a parked caller, and the resulting call belongs to the native entry that
   * is already on screen. {@link attachOutgoingCall} would mint a second UUID
   * and leave the original ringing forever — a stuck CallKit entry, which is
   * the failure iOS penalises hardest.
   *
   * Returns `false` when the entry is gone (the caller hung up, or the user
   * declined, while the call was being placed), which is the signal to hang
   * that call straight back up.
   */
  bindCall(uuid: string, call: Call): boolean {
    const entry = this.byUuid.get(uuid);
    if (!entry || entry.state === 'ended') {
      logger.debug(`No live entry for ${uuid}; the bridge call has nothing to attach to`);
      return false;
    }

    // The intent is cleared: the user's answer is what caused this call to
    // exist, so replaying it against the new call would answer an outbound
    // leg that was never ringing.
    this.write({
      ...entry,
      state: 'fused',
      call,
      expectedCallId: call.id,
      intent: null,
      fuseDeadline: null
    });
    logger.debug(`Bound bridge call ${call.id} to ${uuid}`);
    return true;
  }

  /** Applies an answer/reject, buffering it when the entry is still pending. */
  applyIntent(uuid: string, intent: CallIntent): void {
    const entry = this.byUuid.get(uuid);
    if (!entry || entry.state === 'ended') {
      return;
    }

    if (entry.state === 'pending-push' || !entry.call) {
      logger.debug(`Buffering "${intent}" for ${uuid} until the SDK call arrives`);
      const buffered = { ...entry, intent };
      this.write(buffered);
      if (intent === 'answer') {
        this._answerRequested$.next(buffered);
      }
      return;
    }

    this.runIntent(entry.call, intent);
    this.write({ ...entry, intent: null });
  }

  /** Marks an outgoing call as connected in the native UI. */
  reportConnected(uuid: string): void {
    const entry = this.byUuid.get(uuid);
    if (!entry || entry.state === 'ended') {
      return;
    }
    this.host.reportOutgoingConnected(uuid);
  }

  /** The local side ended the call, from the native UI or in-app. */
  endCall(uuid: string): void {
    const entry = this.byUuid.get(uuid);
    if (!entry || entry.state === 'ended') {
      return;
    }

    void entry.call?.hangup().catch((error: unknown) => {
      logger.debug('Hangup on an already-ended call:', error);
    });

    this.write({ ...entry, state: 'ended', intent: null, fuseDeadline: null });
    this.host.reportCallEnded(uuid, 'local');
  }

  /** The remote side ended the call; tell the native UI. */
  reportRemoteEnded(uuid: string): void {
    const entry = this.byUuid.get(uuid);
    if (!entry || entry.state === 'ended') {
      return;
    }
    this.write({ ...entry, state: 'ended', intent: null, fuseDeadline: null });
    this.host.reportCallEnded(uuid, 'remote');
  }

  /**
   * Expires pending push entries past their fusion deadline.
   *
   * A stuck native call entry is the failure mode iOS punishes hardest, so the
   * host must call this on an interval while any entry is pending.
   */
  tick(): void {
    const now = this.host.now();
    for (const entry of [...this.byUuid.values()]) {
      if (entry.state !== 'pending-push' || entry.fuseDeadline === null) {
        continue;
      }
      if (now > entry.fuseDeadline) {
        logger.warn(`Push entry ${entry.uuid} never fused; reporting a missed call.`);
        this.write({ ...entry, state: 'ended', intent: null, fuseDeadline: null });
        this.host.reportCallEnded(entry.uuid, 'missed');
      }
    }
  }

  destroy(): void {
    this.byUuid.clear();
    this._entries$.complete();
    this._answered$.complete();
    this._answerRequested$.complete();
  }

  // ---------------------------------------------------------------- internals

  private findPending(predicate: (entry: CallEntry) => boolean): CallEntry | undefined {
    for (const entry of this.byUuid.values()) {
      if (entry.state === 'pending-push' && predicate(entry)) {
        return entry;
      }
    }
    return undefined;
  }

  /** Exact id match first; the single-payload-less fallback second. */
  private findFusionTarget(callId: string): CallEntry | undefined {
    const exact = this.findPending((entry) => entry.expectedCallId === callId);
    if (exact) {
      return exact;
    }

    const payloadLess = [...this.byUuid.values()].filter(
      (entry) => entry.state === 'pending-push' && entry.expectedCallId === null
    );

    const only = payloadLess[0];
    if (payloadLess.length === 1 && only) {
      logger.warn(
        `Fusing call ${callId} with push entry ${only.uuid} by fallback — the push ` +
          'payload carried no callId. Include it to make this deterministic.'
      );
      return only;
    }

    if (payloadLess.length > 1) {
      logger.warn(
        `${payloadLess.length} push entries have no callId; refusing to guess. ` +
          `Call ${callId} gets a new entry.`
      );
    }

    return undefined;
  }

  private fuse(entry: CallEntry, call: Call): void {
    const fused: CallEntry = {
      ...entry,
      state: 'fused',
      call,
      expectedCallId: call.id,
      fuseDeadline: null
    };
    this.write(fused);
    logger.debug(`Fused call ${call.id} into ${entry.uuid}`);

    if (entry.intent) {
      this.runIntent(call, entry.intent);
      this.write({ ...fused, intent: null });
    }
  }

  private runIntent(call: Call, intent: CallIntent): void {
    try {
      if (intent === 'answer') {
        this._answered$.next(call);
        // Audio-only, explicitly. A bare answer() lets the SDK's defaults
        // request video, and an SDP answer cannot introduce an m-line the
        // offer lacks — so answering an audio-only call that way fails with
        // "Error creating inbound answer" after the user has already accepted
        // on the native UI. The call gives us no way to inspect the offered
        // m-lines before answering; matching the offer automatically belongs
        // in the SDK. Video answer stays available to in-app UI via
        // useIncomingCalls().answer(call, { video: true }).
        call.answer({ audio: true, video: false });
      } else {
        call.reject();
      }
    } catch (error) {
      logger.warn(`Failed to ${intent} the call:`, error);
    }
  }

  private write(entry: CallEntry): void {
    this.byUuid.set(entry.uuid, entry);
    this._entries$.next([...this.byUuid.values()]);
  }
}
