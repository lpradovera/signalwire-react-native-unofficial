import type { Call } from '@signalwire/js';

export type CallEntryState = 'pending-push' | 'fused' | 'ended';

/** A lock-screen action recorded before the SDK call arrived. */
export type CallIntent = 'answer' | 'reject';

/** The data your push handler forwards from the VoIP/FCM payload. */
export interface PushPayload {
  /** SignalWire call id. Required for reliable fusion. */
  callId?: string;
  /** Caller address or number, shown in the native UI. */
  from?: string;
  /** Caller display name, shown in the native UI. */
  fromName?: string;
  /**
   * Opaque data the push carried, passed through untouched.
   *
   * This package does not interpret it. A bridge topology, for instance, sends
   * a single-use token here that the app hands to its own backend, which
   * resolves it to the parked caller — keeping the real call identifier off the
   * device, where a push payload would otherwise act as a capability anyone
   * replaying it could use.
   */
  data?: Record<string, string>;
}

export interface CallEntry {
  readonly uuid: string;
  readonly state: CallEntryState;
  readonly expectedCallId: string | null;
  readonly call: Call | null;
  readonly handle: string;
  readonly displayName: string;
  readonly intent: CallIntent | null;
  /** Opaque data from the push that created this entry, if any. */
  readonly data?: Record<string, string>;
  /** Deadline for fusion, in `host.now()` milliseconds. Null once fused. */
  readonly fuseDeadline: number | null;
}

/**
 * Why a native call ended, as the registry reports it to its host.
 *
 * - `'missed'`: a push rang until the fusion deadline, unanswered.
 * - `'remote'`: the SDK call ended from the other side.
 * - `'local'`: ended on this device (the native UI, or the app's `endCall`).
 * - `'failed'`: the app gave up on it (`endCall(uuid, 'failed')`), or an
 *   answered push never got its call.
 * - `'declined'`: the user declined a push before its SDK call existed.
 * - `'duplicate'`: a second native display of a call already shown.
 */
/** `'busy'`: refused because another call is live (one call at a time). */
export type CallEndReason = 'missed' | 'remote' | 'local' | 'failed' | 'declined' | 'duplicate' | 'busy';

/** Everything the registry needs from the native layer. */
export interface CallRegistryHost {
  displayIncomingCall(uuid: string, handle: string, displayName: string): void;
  startOutgoingCall(uuid: string, handle: string, displayName: string): void;
  reportOutgoingConnected(uuid: string): void;
  reportCallEnded(uuid: string, reason: CallEndReason): void;
  generateUuid(): string;
  now(): number;
}

export interface CallRegistryOptions {
  host: CallRegistryHost;
  /** How long a push entry may wait for its SDK call, in ms. Default 45000. */
  fusionTimeoutMs?: number;
  /**
   * How many calls may be live at once, a ringing one included. An incoming
   * call or push beyond it is refused as busy (USER_BUSY) and never shown.
   * Default: no limit. The CallKit bridge sets it from `callWaiting`: 1 for
   * `'single'`, 2 otherwise (one call, and one waiting or on hold).
   */
  callLimit?: number;
  /** Same as `callLimit: 1`. Kept for compatibility. */
  refuseIncomingWhileBusy?: boolean;
}
