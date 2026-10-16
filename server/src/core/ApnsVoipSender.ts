import http2 from 'node:http2';

import { signApnsToken } from './jwt.js';
import { TokenExpiredError } from './types.js';

import type { Device, PushPayload, PushSender } from './types.js';

const PRODUCTION_HOST = 'https://api.push.apple.com';
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';

/** Apple rejects provider tokens older than 1h, and regeneration under 20 min. */
const TOKEN_TTL_MS = 30 * 60 * 1000;

export interface ApnsConfig {
  teamId: string;
  keyId: string;
  /** Contents of the .p8 file, including the BEGIN/END lines. */
  privateKey: string;
  /** Your app's bundle id, *without* the `.voip` suffix — this adds it. */
  bundleId: string;
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
 */
export class ApnsVoipSender implements PushSender {
  readonly platform = 'ios' as const;

  private cachedToken: string | null = null;
  private cachedAt = 0;
  private readonly sessions = new Map<string, http2.ClientHttp2Session>();
  private readonly inFlight = new Map<http2.ClientHttp2Session, number>();

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

  private session(host: string): http2.ClientHttp2Session {
    const existing = this.sessions.get(host);
    if (existing && !existing.closed && !existing.destroyed) {
      return existing;
    }

    const session = this.connect(host);
    const forget = (): void => {
      if (this.sessions.get(host) === session) {
        this.sessions.delete(host);
      }
    };
    // A session that fails — APNs unreachable, IPv6 with no route, a captive
    // network — emits `error` on the session, not on a request. Without a
    // listener Node rethrows it as an uncaught exception and takes the whole
    // server down, which is how one flaky moment reaching Apple ended a
    // device-test session. This one is permanent and only forgets the
    // session; each request listens for its own failure below.
    session.on('error', forget);
    session.on('close', forget);
    session.on('goaway', () => {
      forget();
      session.close();
    });
    // Idle, the connection must not keep the process alive.
    session.unref();
    this.sessions.set(host, session);
    return session;
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

  private async exchange(host: string, device: Device, body: string, token: string): Promise<Exchange> {
    const session = this.session(host);
    this.hold(session, 1);

    let onSessionError: ((error: Error) => void) | undefined;
    const sessionFailure = new Promise<never>((_resolve, reject) => {
      onSessionError = reject;
      session.once('error', reject);
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
        request.on('end', () => resolve({ status, body: data }));
        request.on('error', reject);
      });

      return await Promise.race([exchange, sessionFailure]);
    } finally {
      if (onSessionError) {
        session.off('error', onSessionError);
      }
      this.hold(session, -1);
    }
  }

  async send(device: Device, payload: PushPayload): Promise<void> {
    const host = device.environment === 'sandbox' ? SANDBOX_HOST : PRODUCTION_HOST;
    const body = JSON.stringify(payload);

    let token = this.bearer();
    let result = await this.exchange(host, device, body, token);

    // Apple: ExpiredProviderToken means "generate a new token". Keeping the
    // cached one would fail every iOS push until the cache lapsed. Re-mint
    // once and retry this push; a second refusal is a clock or key problem
    // and is reported, not looped on.
    if (result.status === 403 && reasonOf(result.body) === 'ExpiredProviderToken') {
      this.invalidate(token);
      token = this.bearer();
      result = await this.exchange(host, device, body, token);
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
