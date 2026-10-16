import { signGoogleAssertion } from './jwt.js';
import { TokenExpiredError } from './types.js';

import type { Device, PushPayload, PushSender } from './types.js';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ACCESS_TOKEN_TTL_MS = 50 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * How long FCM may hold a call push for a device that is offline.
 *
 * Unset, FCM stores it for four weeks and delivers it on reconnect, and the
 * phone rings for a call that ended hours ago. Sixty seconds matches the
 * bridge token's lifetime and the park window: after that there is nothing
 * left to answer. (APNs gets `apns-expiration: 0` for the same reason.)
 */
export const CALL_PUSH_TTL_SECONDS = 60;

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  /** `private_key` from the service-account JSON, newlines intact. */
  privateKey: string;
  /**
   * Bound on each request to Google. Default 10s, the same as APNs. Without
   * one a stalled endpoint holds the park — and the caller — for undici's
   * five-minute default.
   */
  timeoutMs?: number;
}

/** The parts of an FCM v1 error body that decide whether to prune. */
interface FcmErrorBody {
  error?: {
    message?: string;
    status?: string;
    details?: Array<{
      '@type'?: string;
      errorCode?: string;
      fieldViolations?: Array<{ field?: string; description?: string }>;
    }>;
  };
}

/**
 * Whether an FCM error means this registration token will never work.
 *
 * - `UNREGISTERED` (404): the app was uninstalled or the token rotated.
 * - `SENDER_ID_MISMATCH` (403): the token belongs to another Firebase project,
 *   e.g. a build with an old google-services.json.
 * - `INVALID_ARGUMENT` (400) *about the token*: a malformed registration.
 *   INVALID_ARGUMENT is also what a bad payload gets — that is our bug, the
 *   token is fine, and pruning would delete every device on the first bad
 *   deploy — so it counts only when FCM names `message.token`.
 *
 * https://firebase.google.com/docs/cloud-messaging/manage-tokens
 * https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode
 */
function deadTokenReason(status: number, text: string): string | undefined {
  let body: FcmErrorBody = {};
  try {
    body = JSON.parse(text) as FcmErrorBody;
  } catch {
    // Not JSON: fall through to the status code alone.
  }
  const details = body.error?.details ?? [];
  const errorCode = details.find((detail) => detail.errorCode)?.errorCode;

  if (status === 404 || errorCode === 'UNREGISTERED') {
    return 'UNREGISTERED';
  }
  if (errorCode === 'SENDER_ID_MISMATCH') {
    return 'SENDER_ID_MISMATCH: the token belongs to a different Firebase project';
  }
  if (errorCode === 'INVALID_ARGUMENT' || body.error?.status === 'INVALID_ARGUMENT') {
    const aboutToken = details
      .flatMap((detail) => detail.fieldViolations ?? [])
      .find((violation) => violation.field === 'message.token');
    if (aboutToken) {
      return `INVALID_ARGUMENT: ${aboutToken.description ?? body.error?.message ?? 'invalid registration token'}`;
    }
  }
  return undefined;
}

/**
 * Sends Android call notifications as high-priority FCM **data** messages.
 *
 * Two rules this depends on:
 * - The message must be data-only. Adding a `notification` block hands it to
 *   the system tray and the app's background handler never runs.
 * - `android.priority: 'high'` is what lets it pierce Doze.
 */
/**
 * Keys FCM refuses inside a data payload.
 *
 * `from` is the one that bites: it is the natural name for a caller, APNs
 * accepts it happily, and FCM rejects the whole message with
 * `400 Invalid data payload key: from` — so Android push fails while iOS
 * works, from the same call, with the same payload.
 *
 * https://firebase.google.com/docs/cloud-messaging/concept-options
 */
const RESERVED_KEYS = new Set(['from', 'to', 'notification', 'message_type', 'collapse_key']);

/** `sw_` prefix for anything FCM reserves; the device maps it back. */
function safeKey(key: string): string {
  return RESERVED_KEYS.has(key) || key.startsWith('google') || key.startsWith('gcm')
    ? `sw_${key}`
    : key;
}

/**
 * Builds the data payload, renaming keys FCM will not accept.
 *
 * Every value is a string: FCM data values must be strings, and a number or
 * null here is rejected for the whole message rather than coerced.
 */
export function dataPayload(payload: Record<string, unknown>): Record<string, string> {
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) {
      continue;
    }
    data[safeKey(key)] = String(value);
  }
  return data;
}

export class FcmSender implements PushSender {
  readonly platform = 'android' as const;

  private accessToken: string | null = null;
  private fetchedAt = 0;
  /**
   * The mint in progress, shared. A cold fan-out to N devices otherwise signs
   * N assertions and makes N token exchanges where one would do.
   */
  private minting: Promise<string> | null = null;

  constructor(
    private readonly config: FcmConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private signal(): AbortSignal {
    return AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  private bearer(): Promise<string> {
    if (this.accessToken && Date.now() - this.fetchedAt < ACCESS_TOKEN_TTL_MS) {
      return Promise.resolve(this.accessToken);
    }
    if (!this.minting) {
      this.minting = this.mint().finally(() => {
        this.minting = null;
      });
    }
    return this.minting;
  }

  private async mint(): Promise<string> {
    const now = Date.now();
    const assertion = signGoogleAssertion({
      clientEmail: this.config.clientEmail,
      privateKey: this.config.privateKey,
      scope: SCOPE
    });

    const response = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion
      }),
      signal: this.signal()
    });

    if (!response.ok) {
      throw new Error(`Google OAuth ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as { access_token: string };
    this.accessToken = body.access_token;
    this.fetchedAt = now;
    return this.accessToken;
  }

  /**
   * Forgets an access token FCM refused, unless another send already
   * replaced it.
   */
  private invalidate(token: string): void {
    if (this.accessToken === token) {
      this.accessToken = null;
    }
  }

  private post(device: Device, payload: PushPayload, token: string): Promise<Response> {
    return this.fetchImpl(
      `https://fcm.googleapis.com/v1/projects/${this.config.projectId}/messages:send`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: device.token,
            data: dataPayload(payload),
            android: { priority: 'high', ttl: `${CALL_PUSH_TTL_SECONDS}s` }
          }
        }),
        signal: this.signal()
      }
    );
  }

  async send(device: Device, payload: PushPayload): Promise<void> {
    let token = await this.bearer();
    let response = await this.post(device, payload, token);

    // 401: the cached access token is no good, though it is inside its own
    // TTL (revoked, or minted against a clock Google disagrees with). Keeping
    // it would fail every Android push for up to 50 minutes. Mint once more
    // and retry this push; a second 401 is a credentials problem and is
    // reported, not looped on.
    if (response.status === 401) {
      this.invalidate(token);
      token = await this.bearer();
      response = await this.post(device, payload, token);
    }

    if (response.ok) {
      return;
    }

    const text = await response.text();
    const reason = deadTokenReason(response.status, text);
    if (reason) {
      throw new TokenExpiredError(device.token, reason);
    }
    throw new Error(`FCM ${response.status}: ${text}`);
  }
}
