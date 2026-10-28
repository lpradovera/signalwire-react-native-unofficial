import http2 from 'node:http2';

import { signApnsToken } from './jwt.js';
import { TokenExpiredError } from './types.js';

import type { Device, PushPayload, PushSender } from './types.js';

const PRODUCTION_HOST = 'https://api.push.apple.com';
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';

/** Apple rejects provider tokens older than 1h, and regeneration under 20 min. */
const TOKEN_TTL_MS = 30 * 60 * 1000;

/** How often an open connection is pinged, idle or not. */
const DEFAULT_KEEPALIVE_MS = 60_000;
/** How long a ping may go unanswered before the connection is given up. */
const DEFAULT_PING_TIMEOUT_MS = 10_000;

export interface ApnsConfig {
  teamId: string;
  keyId: string;
  /** Contents of the .p8 file, including the BEGIN/END lines. */
  privateKey: string;
  /** Your app's bundle id, *without* the `.voip` suffix — this adds it. */
  bundleId: string;
  /**
   * HTTP/2 PING interval on the open connection, in ms; 0 turns it off.
   * Default 60 s. An idle connection is otherwise silently dropped by the
   * path to Apple (a NAT or CGNAT mapping expiring after a few minutes), and
   * the next push finds out with `read ECONNRESET`. The ping keeps the
   * mapping alive, and an unanswered one retires the connection before a
   * call needs it.
   */
  keepaliveMs?: number;
  /** How long a ping may go unanswered before the connection is dropped. Default 10 s. */
  pingTimeoutMs?: number;
}

type Connect = (authority: string) => http2.ClientHttp2Session;

/** What one request came back with. */
interface Exchange {
  status: number;
  body: string;
}

/** Apple's `reason` field from an error body, or the raw body. */
function reasonOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    if (typeof parsed.reason === 'string') {
      return parsed.reason;
    }
  } catch {
    // Not JSON; use it as is.
  }
  return body;
}

/**
 * Sends iOS VoIP pushes through PushKit.
 *
 * Three things silently break a VoIP push, all handled here:
 * - `apns-topic` must carry the `.voip` suffix; the plain bundle id is rejected.
 * - `apns-push-type: voip` is mandatory.
 * - Sandbox and production tokens are not interchangeable, so the host is
 *   chosen per-device from `device.environment`.
 *
 * One HTTP/2 connection per host is opened on first use and reused. Apple asks
 * for exactly that ("reuse a connection as long as possible ... many hours to
 * days"), and a fresh TLS + HTTP/2 handshake per push sat on the critical path
 * of every incoming call. A connection that errors, closes or receives GOAWAY
 * is dropped and the next push opens a new one.
 *
 * A reused connection can still be dead without having said so: the network
 * dropped it while idle and the RST arrives only when a push is written. So a
 * push that fails with no response on a reused connection is retried once on
 * a new one, and the connection is pinged (`keepaliveMs`) so that idle ones
 * stay up or are retired early. A failure on a connection just opened is not
 * retried: that is APNs or the network being unreachable, and is reported.
 */
/** The `reason` from a GOAWAY frame's debug data, if it carries Apple's JSON. */
function goawayReason(opaqueData: Buffer | undefined): string | undefined {
  if (!opaqueData || opaqueData.length === 0) {
    return undefined;
  }
  const text = opaqueData.toString('utf8');
  try {
    const parsed = JSON.parse(text) as { reason?: unknown };
    return typeof parsed.reason === 'string' ? parsed.reason : text.slice(0, 120);
  } catch {
    return text.slice(0, 120);
  }
}

export class ApnsVoipSender implements PushSender {
  readonly platform = 'ios' as const;

  private cachedToken: string | null = null;
  private cachedAt = 0;
  private readonly sessions = new Map<string, http2.ClientHttp2Session>();
  private readonly inFlight = new Map<http2.ClientHttp2Session, number>();
  /**
   * Requests waiting on each session, failed together if it errors. One
   * session-level listener for all of them, not one per request: a
   * connection carries many concurrent pushes, and a listener each would
   * trip EventEmitter's leak warning past ten.
   */
  private readonly waiters = new Map<http2.ClientHttp2Session, Set<(error: Error) => void>>();

  constructor(
    private readonly config: ApnsConfig,
    /** Injected for tests. */
    private readonly connect: Connect = (authority) => http2.connect(authority)
  ) {}

  private bearer(): string {
    const now = Date.now();
    if (this.cachedToken && now - this.cachedAt < TOKEN_TTL_MS) {
      return this.cachedToken;
    }
    this.cachedToken = signApnsToken({
      teamId: this.config.teamId,
      keyId: this.config.keyId,
      privateKey: this.config.privateKey
    });
    this.cachedAt = now;
    return this.cachedToken;
  }

  /** Forgets a provider token APNs refused, unless another send replaced it. */
  private invalidate(token: string): void {
    if (this.cachedToken === token) {
      this.cachedToken = null;
    }
  }

  /** The open connection for a host, or a new one; `reused` says which. */
  private session(host: string): { session: http2.ClientHttp2Session; reused: boolean } {
    const existing = this.sessions.get(host);
    if (existing && !existing.closed && !existing.destroyed) {
      return { session: existing, reused: true };
    }

    const session = this.connect(host);
    const waiting = new Set<(error: Error) => void>();
    this.waiters.set(session, waiting);
    const forget = (): void => {
      if (this.sessions.get(host) === session) {
        this.sessions.delete(host);
      }
    };
    // A session that fails — APNs unreachable, IPv6 with no route, a captive
    // network — emits `error` on the session, not on a request. Without a
    // listener Node rethrows it as an uncaught exception and takes the whole
    // server down, which is how one flaky moment reaching Apple ended a
    // device-test session. Forget the session and fail whatever was waiting.
    session.on('error', (error: Error) => {
      forget();
      for (const fail of waiting) {
        fail(error);
      }
    });
    session.on('close', forget);
    session.on('goaway', (errorCode: number, _lastStreamId: number, opaqueData?: Buffer) => {
      forget();
      // Apple puts a JSON reason in the GOAWAY's debug data (e.g. Shutdown,
      // or the provider-token errors). Requests the frame cut off would
      // otherwise wait out their timeout and report nothing useful.
      const reason = goawayReason(opaqueData);
      const error = new Error(
        `APNs sent GOAWAY (code ${errorCode}${reason ? `, reason ${reason}` : ''}) before responding`
      );
      for (const fail of waiting) {
        fail(error);
      }
      session.close();
    });
    // Idle, the connection must not keep the process alive.
    session.unref();
    this.sessions.set(host, session);
    this.keepalive(host, session);
    return { session, reused: false };
  }

  /** Stops using a connection and closes it; requests on it fail and retry. */
  private retire(host: string, session: http2.ClientHttp2Session, error?: Error): void {
    if (this.sessions.get(host) === session) {
      this.sessions.delete(host);
    }
    if (!session.destroyed) {
      session.destroy(error);
    }
  }

  /**
   * Pings the connection every `keepaliveMs`. Traffic keeps a NAT mapping
   * alive; a ping with no answer in `pingTimeoutMs` means the connection is
   * already gone, and it is retired before a push is written into it.
   */
  private keepalive(host: string, session: http2.ClientHttp2Session): void {
    const every = this.config.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
    if (every <= 0) {
      return;
    }
    const timeout = this.config.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
    const timer = setInterval(() => {
      if (session.closed || session.destroyed) {
        return;
      }
      const unanswered = setTimeout(() => {
        this.retire(host, session, new Error(`APNs did not answer a keepalive ping within ${timeout} ms`));
      }, timeout);
      unanswered.unref();
      const sent = session.ping((error) => {
        clearTimeout(unanswered);
        if (error && !session.destroyed) {
          this.retire(host, session, error);
        }
      });
      if (!sent) {
        // Too many pings outstanding: the earlier ones' timers will decide.
        clearTimeout(unanswered);
      }
    }, every);
    timer.unref();
    session.once('close', () => clearInterval(timer));
  }

  private hold(session: http2.ClientHttp2Session, delta: 1 | -1): void {
    const count = (this.inFlight.get(session) ?? 0) + delta;
    if (count > 0) {
      this.inFlight.set(session, count);
      if (delta === 1 && count === 1) {
        session.ref();
      }
      return;
    }
    this.inFlight.delete(session);
    if (!session.destroyed) {
      session.unref();
    }
  }

  /**
   * One push, retried once on a new connection if a reused one fails before
   * APNs answers (see the class comment). `exchange` rejects only for those
   * failures; anything APNs answered comes back as an `Exchange`.
   */
  private async attempt(host: string, device: Device, body: string, token: string): Promise<Exchange> {
    const { session, reused } = this.session(host);
    try {
      return await this.exchange(session, device, body, token);
    } catch (error) {
      if (!reused) {
        throw error;
      }
      this.retire(host, session);
      const first = error instanceof Error ? error.message : String(error);
      try {
        return await this.exchange(this.session(host).session, device, body, token);
      } catch (retryError) {
        const message = retryError instanceof Error ? retryError.message : String(retryError);
        throw new Error(`${message} (retried on a new connection after: ${first})`, { cause: retryError });
      }
    }
  }

  private async exchange(
    session: http2.ClientHttp2Session,
    device: Device,
    body: string,
    token: string
  ): Promise<Exchange> {
    this.hold(session, 1);

    const waiting = this.waiters.get(session);
    let onSessionError: ((error: Error) => void) | undefined;
    const sessionFailure = new Promise<never>((_resolve, reject) => {
      onSessionError = reject;
      waiting?.add(reject);
    });
    // The race below is the only consumer, and it may already have settled by
    // the time the session gives up. Mark the rejection handled so a late one
    // is not an unhandled rejection — which is fatal in Node.
    void sessionFailure.catch(() => {});

    try {
      const request = session.request({
        ':method': 'POST',
        ':path': `/3/device/${device.token}`,
        authorization: `bearer ${token}`,
        'apns-topic': `${this.config.bundleId}.voip`,
        'apns-push-type': 'voip',
        'apns-priority': '10',
        // Deliver now or discard. A late call notification is worse than none.
        'apns-expiration': '0',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      });

      request.setTimeout(10_000, () => request.destroy(new Error('APNs request timed out')));
      request.end(body);

      const exchange = new Promise<Exchange>((resolve, reject) => {
        let status = 0;
        let data = '';

        request.on('response', (headers) => {
          status = Number(headers[':status'] ?? 0);
        });
        request.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        request.on('end', () => {
          if (status === 0) {
            // The stream ended (RST_STREAM NO_ERROR, or the connection went)
            // before APNs sent any response headers: say so, rather than
            // report a status that was never received.
            reject(
              new Error(
                `APNs closed the stream with no response (RST_STREAM code ${request.rstCode ?? 'unknown'})`
              )
            );
            return;
          }
          resolve({ status, body: data });
        });
        request.on('error', reject);
      });

      return await Promise.race([exchange, sessionFailure]);
    } finally {
      if (onSessionError) {
        waiting?.delete(onSessionError);
      }
      this.hold(session, -1);
    }
  }

  async send(device: Device, payload: PushPayload): Promise<void> {
    const host = device.environment === 'sandbox' ? SANDBOX_HOST : PRODUCTION_HOST;
    const body = JSON.stringify(payload);

    let token = this.bearer();
    let result = await this.attempt(host, device, body, token);

    // Apple: ExpiredProviderToken means "generate a new token". Keeping the
    // cached one would fail every iOS push until the cache lapsed. Re-mint
    // once and retry this push; a second refusal is a clock or key problem
    // and is reported, not looped on.
    if (result.status === 403 && reasonOf(result.body) === 'ExpiredProviderToken') {
      this.invalidate(token);
      token = this.bearer();
      result = await this.attempt(host, device, body, token);
    }

    if (result.status === 200) {
      return;
    }

    const reason = reasonOf(result.body);
    // 410: the app is gone from the device, or the token rotated.
    if (result.status === 410 || reason === 'Unregistered') {
      throw new TokenExpiredError(device.token, reason || 'Unregistered');
    }
    // 400 BadDeviceToken: Apple's "invalid, or doesn't match the environment".
    // Pruning is right (Apple: don't retry), but the usual cause is a token
    // registered under the wrong environment — a release build registered as
    // sandbox — not a dead device, so the reason says which one to check.
    if (reason === 'BadDeviceToken') {
      throw new TokenExpiredError(
        device.token,
        `BadDeviceToken: invalid, or not a ${device.environment} token. ` +
          'Check the environment the device registered with: development builds are sandbox, ' +
          'TestFlight and App Store builds are production'
      );
    }
    throw new Error(`APNs ${result.status}: ${result.body || '(no body)'}`);
  }
}
