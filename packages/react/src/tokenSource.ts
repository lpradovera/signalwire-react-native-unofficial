import { BehaviorSubject } from 'rxjs';

import { logger } from './logger';

import type { CredentialProvider, SDKCredential } from '@signalwire/js';
import type { Observable } from 'rxjs';

/** What a {@link FetchToken} resolves with. */
export interface FetchedToken {
  /** A SignalWire subscriber access token (SAT). */
  token: string;
  /**
   * When the token stops working: Unix seconds, epoch milliseconds, or an
   * ISO 8601 string. Without it the token is never renewed ahead of time,
   * and the SDK renews only if the server reports an expiry on connect.
   */
  expiresAt?: number | string;
}

/**
 * Fetches a fresh token from your server. Called to connect, again shortly
 * before each token expires, and when the app comes back to the foreground or
 * a call push arrives with the token near or past its expiry.
 *
 * Throw on failure. An error with a `status` of 401 or 403 (for example a
 * {@link TokenFetchError}) means the user is no longer allowed a token: it is
 * reported as `'unauthorized'` and not retried. Anything else is retried with
 * a backoff.
 */
export type FetchToken = () => Promise<FetchedToken>;

/**
 * - `'fetching'`: getting the first token.
 * - `'ready'`: the current token is good.
 * - `'renewing'`: getting the next token while the current one still works.
 * - `'retrying'`: a fetch failed; `error` says why, and it is tried again.
 * - `'unauthorized'`: the server refused with 401 or 403. Not retried: the
 *   client cannot connect or stay connected, so incoming calls cannot reach
 *   this device until the app signs the user in again and passes a new
 *   `fetchToken`.
 */
export type TokenState = 'fetching' | 'ready' | 'renewing' | 'retrying' | 'unauthorized';

export interface TokenStatus {
  readonly state: TokenState;
  /** When the current token expires, in epoch milliseconds, if known. */
  readonly expiresAt: number | undefined;
  /** The last failure, while `'retrying'` or `'unauthorized'`. */
  readonly error: Error | null;
}

/**
 * An error for a `fetchToken` to throw with the HTTP status the token server
 * answered. A 401 or 403 is reported as `'unauthorized'` and not retried.
 */
export class TokenFetchError extends Error {
  readonly status: number | undefined;
  readonly cause: unknown;

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message);
    this.name = 'TokenFetchError';
    this.status = options.status;
    this.cause = options.cause;
  }
}

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** A renewed token closer than this to its own expiry is not handed out. */
const MIN_REMAINING_MS = 10_000;

/** Unix seconds below this, epoch milliseconds above (this is the year 33658 in seconds). */
const SECONDS_LIMIT = 1e12;

/**
 * Reads `expiresAt` as epoch milliseconds. A number (or numeric string) is
 * seconds when below 1e12 and milliseconds otherwise; any other string is
 * parsed as a date. Unreadable or non-positive values are unknown.
 */
export function toExpiryMs(value: number | string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  let numeric: number;
  if (typeof value === 'number') {
    numeric = value;
  } else if (/^\s*\d+(\.\d+)?\s*$/.test(value)) {
    numeric = Number(value);
  } else {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return undefined;
  }
  return numeric < SECONDS_LIMIT ? numeric * 1000 : numeric;
}

/**
 * How long before expiry a token is renewed: a fifth of its lifetime, at
 * least 10 s and at most 60 s, and never more than half of it. The SDK's own
 * refresh fires 5 s before expiry; renewing earlier leaves room to retry.
 */
function renewalLeadMs(lifetimeMs: number): number {
  return Math.min(Math.max(lifetimeMs * 0.2, 10_000), 60_000, lifetimeMs / 2);
}

function isUnauthorized(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const record = error as { status?: unknown; statusCode?: unknown };
  const status = typeof record.status === 'number' ? record.status : record.statusCode;
  return status === 401 || status === 403;
}

interface Held {
  credential: SDKCredential;
  expiresAt: number | undefined;
  fetchedAt: number;
}

export interface TokenSourceOptions {
  /** Test seam for the backoff jitter. Default `Math.random`. */
  random?: () => number;
}

/**
 * Turns a `fetchToken` into the SDK's `CredentialProvider`, and keeps it
 * supplied.
 *
 * `authenticate()` and `refresh()` both fetch through it, retrying failures
 * with a capped exponential backoff, so a network drop at renewal time never
 * leaves the session on a dead token. Each token is renewed shortly before it
 * expires, and the renewed token is what the SDK's next `refresh()` receives,
 * so the SDK's own refresh (5 s before expiry) does not have to wait for the
 * network. A 401 or 403 stops it: that is reported, not retried.
 *
 * Used by `SignalWireProvider` for its `fetchToken` prop.
 */
export class TokenSource {
  readonly credentialProvider: CredentialProvider;

  private readonly random: () => number;
  private readonly _status$ = new BehaviorSubject<TokenStatus>({
    state: 'fetching',
    expiresAt: undefined,
    error: null
  });
  /** The newest token fetched. */
  private latest: Held | null = null;
  /** The token the SDK was last given. */
  private handedOut: Held | null = null;
  private inflight: Promise<Held> | null = null;
  private renewalTimer: ReturnType<typeof setTimeout> | null = null;
  /** Ends the current backoff wait early. */
  private wake: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly fetchToken: FetchToken,
    options: TokenSourceOptions = {}
  ) {
    this.random = options.random ?? Math.random;
    this.credentialProvider = {
      authenticate: () => this.obtain(),
      refresh: () => this.obtain()
    };
  }

  get status$(): Observable<TokenStatus> {
    return this._status$.asObservable();
  }

  get status(): TokenStatus {
    return this._status$.value;
  }

  /**
   * Renews now if the token is near or past its expiry, and retries a failed
   * fetch now rather than after its backoff. For the moments timers missed: a
   * phone app's timers do not run while it is suspended, so this runs when it
   * comes back to the foreground and when a call push wakes it.
   */
  renewIfDue(): void {
    if (this.disposed) {
      return;
    }
    if (this.wake) {
      this.wake();
      return;
    }
    const held = this.latest;
    if (!held || held.expiresAt === undefined || this.inflight) {
      return;
    }
    if (held.expiresAt - Date.now() <= renewalLeadMs(held.expiresAt - held.fetchedAt)) {
      this.renew();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearRenewal();
    this.wake?.();
    this._status$.complete();
  }

  // ---------------------------------------------------------------- internals

  /** For the SDK: a renewed token not yet handed out, or a fresh fetch. */
  private async obtain(): Promise<SDKCredential> {
    const latest = this.latest;
    if (
      latest &&
      latest !== this.handedOut &&
      !this.inflight &&
      (latest.expiresAt === undefined || latest.expiresAt - Date.now() > MIN_REMAINING_MS)
    ) {
      this.handedOut = latest;
      return latest.credential;
    }
    const held = await this.fetchShared();
    this.handedOut = held;
    return held.credential;
  }

  private renew(): void {
    void this.fetchShared().catch(() => {
      // Reported through the status; the SDK's next refresh() tries again.
    });
  }

  /** One fetch at a time: a renewal and the SDK's refresh() share it. */
  private fetchShared(): Promise<Held> {
    this.inflight ??= this.fetchWithRetry().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchWithRetry(): Promise<Held> {
    this.setStatus(this.latest ? 'renewing' : 'fetching', null);
    for (let attempt = 0; ; attempt++) {
      if (this.disposed) {
        throw new Error('TokenSource disposed');
      }
      try {
        const fetched = await this.fetchToken();
        if (this.disposed) {
          throw new Error('TokenSource disposed');
        }
        if (typeof fetched?.token !== 'string' || fetched.token.length === 0) {
          throw new Error('fetchToken resolved with no token');
        }
        const expiresAt = toExpiryMs(fetched.expiresAt);
        if (fetched.expiresAt !== undefined && expiresAt === undefined) {
          logger.warn(`fetchToken returned an unreadable expiresAt (${String(fetched.expiresAt)}); not renewing ahead`);
        }
        const held: Held = {
          credential: expiresAt === undefined ? { token: fetched.token } : { token: fetched.token, expiry_at: expiresAt },
          expiresAt,
          fetchedAt: Date.now()
        };
        this.latest = held;
        this._status$.next({ state: 'ready', expiresAt, error: null });
        this.scheduleRenewal(held);
        return held;
      } catch (caught) {
        if (this.disposed) {
          throw new Error('TokenSource disposed');
        }
        const error = caught instanceof Error ? caught : new Error(String(caught));
        if (isUnauthorized(caught)) {
          logger.error('fetchToken was refused (401/403); not retrying:', error);
          this.setStatus('unauthorized', error);
          throw caught;
        }
        const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS) * (0.5 + 0.5 * this.random());
        logger.warn(`fetchToken failed; retrying in ${Math.round(delay)} ms:`, error);
        this.setStatus('retrying', error);
        await this.sleep(delay);
      }
    }
  }

  private scheduleRenewal(held: Held): void {
    this.clearRenewal();
    if (held.expiresAt === undefined || this.disposed) {
      return;
    }
    const lead = renewalLeadMs(held.expiresAt - held.fetchedAt);
    const delay = Math.max(held.expiresAt - lead - Date.now(), 0);
    this.renewalTimer = setTimeout(() => {
      this.renewalTimer = null;
      this.renew();
    }, delay);
  }

  private clearRenewal(): void {
    if (this.renewalTimer !== null) {
      clearTimeout(this.renewalTimer);
      this.renewalTimer = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this; // eslint-disable-line @typescript-eslint/no-this-alias
      function done(): void {
        clearTimeout(timer);
        if (self.wake === done) {
          self.wake = null;
        }
        resolve();
      }
      this.wake = done;
    });
  }

  private setStatus(state: TokenState, error: Error | null): void {
    if (this.disposed) {
      return;
    }
    this._status$.next({ state, expiresAt: this.latest?.expiresAt, error });
  }
}
