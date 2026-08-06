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
}

export interface BridgeTokenStoreOptions {
  /**
   * How long a token stays redeemable. Long enough for a cold start — app
   * launch, token fetch, WebSocket, authentication — plus the seconds a person
   * takes to notice a ringing phone. Short enough that a leaked token is
   * worthless by the time anyone could use it.
   */
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 60_000;

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
  private readonly now: () => number;

  constructor(options: BridgeTokenStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  mint(callSid: string, externalUserId: string): BridgeToken {
    this.sweep();
    const token: BridgeToken = {
      token: randomUUID(),
      callSid,
      externalUserId,
      expiresAt: this.now() + this.ttlMs,
      redeemedAt: null
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
  redeem(
    token: string,
    externalUserId: string
  ): { callSid: string } | { error: 'unknown' | 'expired' | 'already-redeemed' | 'wrong-subscriber' } {
    const found = this.byToken.get(token);
    if (!found) {
      return { error: 'unknown' };
    }
    if (found.redeemedAt !== null) {
      return { error: 'already-redeemed' };
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

  private sweep(): void {
    const cutoff = this.now();
    for (const [key, value] of this.byToken) {
      // Redeemed tokens are kept until expiry so a replay reports
      // "already-redeemed" rather than "unknown" — the difference matters when
      // reading logs after a failed bridge.
      if (cutoff > value.expiresAt) {
        this.byToken.delete(key);
      }
    }
  }
}
