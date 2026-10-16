import { randomUUID } from 'node:crypto';

/** A parked caller, referenced by a token safe to put in a push. */
export interface BridgeToken {
  token: string;
  /** The parked call's SID. Never leaves this server. */
  callSid: string;
  /** Subscriber the call is for; the only identity allowed to redeem it. */
  externalUserId: string;
  expiresAt: number;
  redeemedAt: number | null;
  /** Set when the user declined; a declined call can no longer be bridged. */
  declinedAt: number | null;
  /** Set once the caller's leg has been ended for this token. */
  callerEndedAt: number | null;
}

export type RedeemError = 'unknown' | 'expired' | 'already-redeemed' | 'declined' | 'wrong-subscriber';

export interface BridgeTokenStoreOptions {
  /**
   * How long a token stays redeemable. Long enough for a cold start — app
   * launch, token fetch, WebSocket, authentication — plus the seconds a person
   * takes to notice a ringing phone. Short enough that a leaked token is
   * worthless by the time anyone could use it.
   */
  ttlMs?: number;
  /**
   * How long a redeemed (bridged) token is kept for its status callback. The
   * callback comes when the device's leg ends, so this bounds the longest call
   * whose caller can still be hung up. It only stops a callback that never
   * arrives from keeping the entry forever.
   */
  bridgedTtlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_BRIDGED_TTL_MS = 24 * 60 * 60_000;

/**
 * Maps opaque tokens to parked calls.
 *
 * The push carries the token, never the call SID. A SID in a push payload is a
 * capability: anyone replaying it could bridge into the call. A token can be
 * scoped to one subscriber, spent once, and expired — so redemption is a
 * decision this server makes rather than a fact the device asserts.
 *
 * In memory on purpose. A parked call does not outlive the process holding it
 * open, so persistence would only preserve tokens for calls that are already
 * gone.
 */
export class BridgeTokenStore {
  private readonly byToken = new Map<string, BridgeToken>();
  private readonly ttlMs: number;
  private readonly bridgedTtlMs: number;
  private readonly now: () => number;

  constructor(options: BridgeTokenStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.bridgedTtlMs = options.bridgedTtlMs ?? DEFAULT_BRIDGED_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  mint(callSid: string, externalUserId: string): BridgeToken {
    this.sweep();
    const token: BridgeToken = {
      token: randomUUID(),
      callSid,
      externalUserId,
      expiresAt: this.now() + this.ttlMs,
      redeemedAt: null,
      declinedAt: null,
      callerEndedAt: null
    };
    this.byToken.set(token.token, token);
    return token;
  }

  /**
   * Spends a token, returning the parked call's SID.
   *
   * `externalUserId` is checked, not trusted: without it any subscriber holding
   * a token could bridge into a call meant for someone else. Returns a reason
   * rather than throwing, so the caller can answer SignalWire with SWML that
   * hangs up politely instead of a 500.
   */
  redeem(token: string, externalUserId: string): { callSid: string } | { error: RedeemError } {
    const found = this.byToken.get(token);
    if (!found) {
      return { error: 'unknown' };
    }
    if (found.redeemedAt !== null) {
      return { error: 'already-redeemed' };
    }
    if (found.declinedAt !== null) {
      return { error: 'declined' };
    }
    if (this.now() > found.expiresAt) {
      return { error: 'expired' };
    }
    if (found.externalUserId !== externalUserId) {
      return { error: 'wrong-subscriber' };
    }

    found.redeemedAt = this.now();
    return { callSid: found.callSid };
  }

  /** Test/debug view. */
  get size(): number {
    this.sweep();
    return this.byToken.size;
  }

  /**
   * Redeems without checking who is calling.
   *
   * For requests where the caller cannot be identified. Still single-use and
   * still expiring — the token remains the capability; only the extra
   * subscriber check is skipped.
   */
  redeemAnySubscriber(
    token: string
  ): { callSid: string } | { error: Exclude<RedeemError, 'wrong-subscriber'> } {
    const found = this.byToken.get(token);
    if (!found) {
      return { error: 'unknown' };
    }
    const result = this.redeem(token, found.externalUserId);
    return result as { callSid: string } | { error: Exclude<RedeemError, 'wrong-subscriber'> };
  }

  /**
   * Records that the user declined, returning the parked call to end.
   *
   * Only before anyone answered: once a device has bridged, ending the call
   * is that device's hangup, reported by SignalWire's status callback. A
   * declined token can no longer be redeemed, so a second device answering a
   * moment later is turned away rather than joined to a caller being hung up.
   */
  decline(
    token: string
  ):
    | { callSid: string }
    | { error: 'unknown' | 'expired' | 'already-redeemed' | 'already-declined' } {
    const found = this.byToken.get(token);
    if (!found) {
      return { error: 'unknown' };
    }
    if (found.redeemedAt !== null) {
      return { error: 'already-redeemed' };
    }
    if (found.declinedAt !== null) {
      return { error: 'already-declined' };
    }
    if (this.now() > found.expiresAt) {
      return { error: 'expired' };
    }
    found.declinedAt = this.now();
    return { callSid: found.callSid };
  }

  /**
   * Claims the one end of the caller's leg that a bridged token allows.
   *
   * For SignalWire's status callback on the bridge's connect. Only a redeemed
   * token qualifies — the status_url is handed out by a successful bridge, so
   * a callback for an unredeemed token did not come from that connect — and
   * only once, so repeated callbacks (or a replayed one) end nothing further.
   *
   * The token alone is not proof the request came from SignalWire: it is the
   * same value pushed to every device of the user. With a signing key
   * configured, the route checks SignalWire's signature first.
   */
  claimCallerEnd(
    token: string
  ): { callSid: string } | { error: 'unknown' | 'not-redeemed' | 'already-ended' } {
    this.sweep();
    const found = this.byToken.get(token);
    if (!found) {
      return { error: 'unknown' };
    }
    if (found.redeemedAt === null) {
      return { error: 'not-redeemed' };
    }
    if (found.callerEndedAt !== null) {
      return { error: 'already-ended' };
    }
    found.callerEndedAt = this.now();
    return { callSid: found.callSid };
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, value] of this.byToken) {
      if (this.isSpent(value, now)) {
        this.byToken.delete(key);
      }
    }
  }

  /**
   * Whether an entry can be forgotten.
   *
   * - Never redeemed: at expiry. Nothing can use it after that.
   * - Redeemed, caller not yet ended: when its status callback comes, which is
   *   when the device's leg ends, however long the call ran. `bridgedTtlMs`
   *   only bounds a callback that never arrives. Sweeping it at the 60 s
   *   expiry instead stranded the caller of every call that ran past the
   *   first minute after the park.
   * - Caller ended: at expiry, or shortly after the end, whichever is later,
   *   so a repeated callback or a replayed bridge reports "already-ended" /
   *   "already-redeemed" rather than "unknown" in the logs.
   */
  private isSpent(value: BridgeToken, now: number): boolean {
    if (value.callerEndedAt !== null) {
      return now > Math.max(value.expiresAt, value.callerEndedAt + this.ttlMs);
    }
    if (value.redeemedAt !== null) {
      return now > value.redeemedAt + this.bridgedTtlMs;
    }
    return now > value.expiresAt;
  }
}
