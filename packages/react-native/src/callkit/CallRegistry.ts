import { BehaviorSubject, Subject, concat, defer, from } from 'rxjs';

import { logger } from '@signalwire/react';

import type {
  CallEndReason,
  CallEntry,
  CallIntent,
  CallRegistryHost,
  CallRegistryOptions,
  PushPayload
} from './types';
import type { Call } from '@signalwire/js';
import type { Observable } from 'rxjs';

/**
 * How long a pushed call rings before it is written off as missed.
 *
 * For a call that fuses with an inbound SDK call this is a safety net. For a
 * bridge topology it is the ring duration itself: no inbound call is ever
 * coming, so this timer is the only thing ending an unanswered call.
 *
 * 20s was too short for both. A cold start has to launch the app, load
 * JavaScript, connect and register before anything can be shown — and in a
 * development build it also downloads the bundle — so a call could expire
 * before the user ever saw it. Real phones ring for about 30 seconds, and the
 * server parks its caller for 60. Override with `fusionTimeoutMs`.
 */
const DEFAULT_FUSION_TIMEOUT_MS = 45_000;

/**
 * How long an *answered* entry may wait for the app to produce its call.
 *
 * The fusion deadline measures something else — how long a ringing push waits
 * for an inbound SDK call — and once the user answers, that question is
 * settled. In a bridge topology no inbound call is ever coming: the app dials
 * out instead, which takes a token round-trip, a dial and ICE. Letting the
 * original deadline run tore the entry down mid-dial, and the call the user
 * had already accepted was reported as missed.
 */
const ANSWERED_TIMEOUT_MS = 60_000;
const UNKNOWN_HANDLE = 'Unknown';
/**
 * The one spelling of a UUID the registry keys on.
 *
 * callkeep's iOS module reports every CallKit action (answer, end, hold,
 * DTMF, mute) with the UUID lower-cased, while a PushKit display and the
 * cached launch push carry it as the push or `[[NSUUID UUID] UUIDString]`
 * spelled it, which is upper-case. Compared verbatim, every action for such a
 * call missed its entry: no answer, no hang-up, and a missed call 45 s later.
 * CallKit and Telecom parse a UUID in either case, so lower-case is safe to
 * hand back to them.
 */
function normalizeUuid(uuid: string): string {
  return uuid.toLowerCase();
}
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
  private fusionTimeoutMs: number;
  private readonly _entries$ = new BehaviorSubject<CallEntry[]>([]);
  private readonly _answered$ = new Subject<Call>();
  private readonly _answerRequested$ = new Subject<CallEntry>();
  private readonly _rejectRequested$ = new Subject<CallEntry>();
  private readonly byUuid = new Map<string, CallEntry>();
  /**
   * Entries whose answer or reject request reached a subscriber. A request is
   * delivered once: the subscriber that got it acts on it (dials, or tells
   * the server) whether or not it stays subscribed, so replaying it to the
   * next subscriber started a second dial for one answer.
   */
  private readonly deliveredAnswers = new Set<string>();
  private readonly deliveredRejects = new Set<string>();

  constructor(options: CallRegistryOptions) {
    this.host = options.host;
    this.fusionTimeoutMs = options.fusionTimeoutMs ?? DEFAULT_FUSION_TIMEOUT_MS;
  }

  /**
   * Sets how long a push entry waits for its SDK call, for the pushes reported
   * from now on. `getCallKit()` builds its registry before the app's
   * `setup()` runs, so this is how `CallKitSetupOptions.fusionTimeoutMs`
   * reaches it. A value that is not a positive number is ignored.
   */
  setFusionTimeoutMs(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) {
      logger.warn(`Ignoring fusionTimeoutMs ${String(ms)}; keeping ${this.fusionTimeoutMs}`);
      return;
    }
    this.fusionTimeoutMs = ms;
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
    // Replays answers that are still waiting for a call to be placed.
    //
    // A plain Subject drops anything emitted before its subscriber exists,
    // and on a cold start that is the normal order: the push launches the
    // app, the user answers from the lock screen, and the intent is applied
    // while React is still mounting. The answer reached JavaScript and was
    // buffered on the entry, but the hook that dials the bridge subscribed a
    // moment too late and never saw it — so nothing dialled and the caller
    // sat on a parked leg until it timed out.
    //
    // Only entries still awaiting a call, and only answers no subscriber has
    // had, are replayed: the subscriber that got one is placing its call (the
    // dial outlives a re-subscription), so a later one must not dial again.
    return defer(() => {
      const outstanding = this.entries.filter(
        (entry) =>
          entry.intent === 'answer' &&
          entry.state !== 'ended' &&
          !entry.call &&
          !this.deliveredAnswers.has(entry.uuid)
      );
      for (const entry of outstanding) {
        this.deliveredAnswers.add(entry.uuid);
      }
      return concat(from(outstanding), this._answerRequested$);
    });
  }

  /**
   * Emits when the user declines (or ends) a push entry that has no SDK call.
   *
   * The twin of {@link answerRequested$}. With an SDK call on its way, the
   * buffered reject turns that call down when it fuses. In a bridge flow
   * nothing is coming: the caller is parked on the app's server, and only the
   * app can tell it the user said no. Without that the caller hears ringback
   * until the park times out.
   *
   * Each decline is delivered once, to the subscribers present, or replayed
   * to the first subscriber when none was (a decline on the lock screen while
   * React mounts).
   */
  get rejectRequested$(): Observable<CallEntry> {
    return defer(() => {
      const outstanding = this.entries.filter(
        (entry) =>
          entry.intent === 'reject' &&
          entry.state === 'pending-push' &&
          !entry.call &&
          !this.deliveredRejects.has(entry.uuid)
      );
      for (const entry of outstanding) {
        this.deliveredRejects.add(entry.uuid);
      }
      return concat(from(outstanding), this._rejectRequested$);
    });
  }

  get entries(): CallEntry[] {
    return this._entries$.value;
  }

  entryForUuid(uuid: string): CallEntry | undefined {
    return this.byUuid.get(normalizeUuid(uuid));
  }

  /**
   * Whether the entry's call is still going on.
   *
   * An ended entry is over, and so is a push the user ended in the native UI
   * before its SDK call existed: that entry stays `'pending-push'`, holding a
   * buffered `'reject'` so an inbound call that still arrives is turned down
   * rather than ringing again, but nothing may bind to it, start audio for it
   * or keep audio running for it.
   */
  isLive(uuid: string): boolean {
    const entry = this.entryForUuid(uuid);
    if (!entry || entry.state === 'ended') {
      return false;
    }
    return !(entry.state === 'pending-push' && entry.intent === 'reject');
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
   * A push for a call id the registry already has (a duplicate push, or one
   * that arrives after its SDK invite was shown) returns that entry's UUID
   * and shows nothing new.
   */
  reportIncomingPush(payload: PushPayload): string {
    if (payload.callId) {
      const existing = this.entryForCallId(payload.callId);
      if (existing) {
        logger.debug(`Push for call ${payload.callId} already has ${existing.uuid}; not showing it again`);
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

    const uuid = normalizeUuid(this.host.generateUuid());
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

  /**
   * Records a call the native layer already displayed.
   *
   * On a cold start the VoIP push is reported to CallKit before JavaScript
   * exists, so the entry has a UUID the native side chose. Reporting it here
   * rather than minting a new one keeps a single identity for the call — a
   * second UUID would leave the ringing native entry orphaned, which is the
   * stuck-call-log failure iOS penalises hardest.
   *
   * Idempotent: callkeep may replay the event, and the app may also call
   * `reportIncomingPush` for the same call.
   */
  adoptNativeEntry(payload: PushPayload & { uuid: string }): void {
    const uuid = normalizeUuid(payload.uuid);
    const existing = this.byUuid.get(uuid);
    if (existing) {
      // Later knowledge wins, but nothing already learned is discarded.
      this.write({
        ...existing,
        expectedCallId: existing.expectedCallId ?? payload.callId ?? null,
        data: existing.data ?? payload.data
      });
      return;
    }

    const entry: CallEntry = {
      uuid,
      state: 'pending-push',
      expectedCallId: payload.callId ?? null,
      call: null,
      handle: payload.from ?? UNKNOWN_HANDLE,
      displayName: payload.fromName ?? UNKNOWN_NAME,
      intent: null,
      data: payload.data,
      fuseDeadline: this.host.now() + this.fusionTimeoutMs
    };

    // The native side showed this push as a call of its own, but the call is
    // already here under another entry (its SDK invite won the race). Two
    // native calls for one call: end the duplicate now, or it rings as a
    // waiting call that never fuses and is reported missed at the deadline.
    const original = payload.callId ? this.entryForCallId(payload.callId) : undefined;
    if (original) {
      logger.debug(`Native push ${uuid} duplicates ${original.uuid} for call ${payload.callId}; ending it`);
      this.write({ ...entry, state: 'ended', fuseDeadline: null });
      this.host.reportCallEnded(uuid, 'duplicate');
      return;
    }

    this.write(entry);
    logger.debug(`Adopted native push entry ${uuid}`);
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

    const uuid = normalizeUuid(this.host.generateUuid());
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

    const uuid = normalizeUuid(this.host.generateUuid());
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
   * declined or ended it, while the call was being placed), or already has a
   * different call (a second dial for the same answer), which is the signal
   * to hang that call straight back up.
   */
  bindCall(uuid: string, call: Call): boolean {
    const entry = this.entryForUuid(uuid);
    if (!entry || !this.isLive(uuid)) {
      logger.debug(`No live entry for ${uuid}; the bridge call has nothing to attach to`);
      return false;
    }
    if (entry.call && entry.call !== call) {
      // Rebinding would orphan the first call: joined to the caller, watched
      // by nothing, never hung up.
      logger.warn(`Entry ${entry.uuid} already has call ${entry.call.id}; refusing ${call.id}`);
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
    const entry = this.entryForUuid(uuid);
    if (!entry || entry.state === 'ended') {
      return;
    }

    if (entry.state === 'pending-push' || !entry.call) {
      if (entry.intent === intent) {
        // The same answer twice (an in-app answer and its CallKit echo, a
        // double tap) must not ask for a second call, and the same decline
        // twice (callkeep echoes an end the app asked for) must not end it
        // twice.
        logger.debug(`"${intent}" for ${entry.uuid} is already buffered`);
        return;
      }
      logger.debug(`Buffering "${intent}" for ${entry.uuid} until the SDK call arrives`);
      // An answered entry is no longer waiting to fuse, it is waiting for the
      // app. Restart the clock, generously: the alternative is expiring a call
      // the user has already accepted.
      const buffered = {
        ...entry,
        intent,
        fuseDeadline:
          intent === 'answer' ? this.host.now() + ANSWERED_TIMEOUT_MS : entry.fuseDeadline
      };
      this.write(buffered);
      if (intent === 'answer') {
        this.request(this._answerRequested$, this.deliveredAnswers, buffered);
        return;
      }
      // Declined: the native call ends now, rather than ringing on (in
      // Telecom, behind an in-app decline) until the deadline reports it
      // missed. The entry stays pending, holding the reject for an SDK call
      // that may still arrive, and the app is asked to turn a call with none
      // coming down at its server.
      this.host.reportCallEnded(entry.uuid, 'declined');
      this.request(this._rejectRequested$, this.deliveredRejects, buffered);
      return;
    }

    this.runIntent(entry.call, intent);
    this.write({ ...entry, intent: null });
  }

  /** Marks an outgoing call as connected in the native UI. */
  reportConnected(uuid: string): void {
    const entry = this.entryForUuid(uuid);
    if (!entry || entry.state === 'ended') {
      return;
    }
    this.host.reportOutgoingConnected(entry.uuid);
  }

  /**
   * The local side ended the call, from the native UI or in-app.
   *
   * Pass `'failed'` when the app ends it because it could not go on (a bridge
   * dial that failed, an SDK that never connected), so the native UI shows a
   * failed call rather than one the other party hung up.
   */
  endCall(uuid: string, reason: 'local' | 'failed' = 'local'): void {
    const entry = this.entryForUuid(uuid);
    if (!entry || entry.state === 'ended') {
      return;
    }

    void entry.call?.hangup().catch((error: unknown) => {
      logger.debug('Hangup on an already-ended call:', error);
    });

    this.write({ ...entry, state: 'ended', intent: null, fuseDeadline: null });
    this.host.reportCallEnded(entry.uuid, reason);
  }

  /** The remote side ended the call; tell the native UI. */
  reportRemoteEnded(uuid: string): void {
    const entry = this.entryForUuid(uuid);
    if (!entry || entry.state === 'ended') {
      return;
    }
    this.write({ ...entry, state: 'ended', intent: null, fuseDeadline: null });
    this.host.reportCallEnded(entry.uuid, 'remote');
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
        this.write({ ...entry, state: 'ended', intent: null, fuseDeadline: null });
        if (entry.intent === 'reject') {
          // Its native call was ended as declined when the user declined it;
          // this only stops waiting for an SDK call to turn down.
          logger.debug(`Declined entry ${entry.uuid} saw no SDK call; done waiting.`);
          continue;
        }
        const reason: CallEndReason = entry.intent === 'answer' ? 'failed' : 'missed';
        logger.warn(
          reason === 'failed'
            ? `Answered entry ${entry.uuid} never got its call; giving up.`
            : `Push entry ${entry.uuid} never fused; reporting a missed call.`
        );
        this.host.reportCallEnded(entry.uuid, reason);
      }
    }
  }

  destroy(): void {
    this.byUuid.clear();
    this._entries$.complete();
    this._answered$.complete();
    this._answerRequested$.complete();
    this._rejectRequested$.complete();
  }

  // ---------------------------------------------------------------- internals

  /**
   * Emits a request, marking it delivered when a subscriber is there to get
   * it; otherwise the request getter replays it to the first one.
   */
  private request(subject: Subject<CallEntry>, delivered: Set<string>, entry: CallEntry): void {
    if (subject.observed) {
      delivered.add(entry.uuid);
    }
    subject.next(entry);
  }

  /** Any entry, in any state, already standing for this call id. */
  private entryForCallId(callId: string): CallEntry | undefined {
    for (const entry of this.byUuid.values()) {
      if (entry.expectedCallId === callId) {
        return entry;
      }
    }
    return undefined;
  }

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
