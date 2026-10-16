/**
 * Mints Fabric subscriber tokens.
 *
 * One of the SignalWire adapters in `signalwire/`. It exists so that project credentials stay on a server: a subscriber token is
 * short-lived and scoped to one subscriber, but the project ID and API token
 * that mint it are neither. Shipping those in an app bundle would let anyone
 * who unzips the IPA mint tokens for every subscriber in the space.
 */

/**
 * The space's hostname from `SIGNALWIRE_SPACE`, which people write with or
 * without a scheme and a trailing slash.
 */
export function spaceHost(space: string): string {
  return space.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

export interface SubscriberTokenMinterOptions {
  /** Space hostname, e.g. `example.signalwire.com`. */
  space: string;
  projectId: string;
  apiToken: string;
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** How long each token lives, in seconds. Default 7200 (two hours). */
  ttlSeconds?: number;
  /** Injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Bound on the request to SignalWire. Default 10s. */
  timeoutMs?: number;
}

/** SignalWire's own default lifetime for a subscriber token. */
export const DEFAULT_TOKEN_TTL_SECONDS = 7200;

export interface SubscriberToken {
  token: string;
  /** When the token stops working, in Unix seconds: the `expire_at` it was minted with. */
  expiresAt: number;
  /** Whatever SignalWire echoed back, for debugging. Shape is not relied on. */
  raw: unknown;
}

export class SubscriberTokenError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'SubscriberTokenError';
  }
}

/** Reads the token out of the response, tolerating a couple of field names. */
function extractToken(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  for (const key of ['token', 'jwt_token', 'access_token']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export class SubscriberTokenMinter {
  private readonly endpoint: string;
  private readonly authorization: string;
  private readonly fetchImpl: typeof fetch;
  private readonly ttlSeconds: number;
  private readonly now: () => number;

  constructor(private readonly options: SubscriberTokenMinterOptions) {
    this.endpoint = `https://${spaceHost(options.space)}/api/fabric/subscribers/tokens`;
    this.authorization = `Basic ${Buffer.from(`${options.projectId}:${options.apiToken}`).toString('base64')}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;
    this.now = options.now ?? Date.now;
  }

  /**
   * `reference` identifies the subscriber within your space. It is the value
   * your own user record maps to — not something the client may choose, which
   * is why the route derives it from an authenticated caller.
   */
  async mint(reference: string): Promise<SubscriberToken> {
    // Chosen here, not left to SignalWire's default, so the app is told when
    // the token ends and can renew it before then (fetchToken's expiresAt).
    const expiresAt = Math.floor(this.now() / 1000) + this.ttlSeconds;
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: this.authorization
      },
      body: JSON.stringify({ reference, expire_at: expiresAt }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000)
    });

    const text = await response.text();
    let body: unknown;
    try {
      body = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      body = text;
    }

    if (!response.ok) {
      throw new SubscriberTokenError(
        `SignalWire refused to mint a token (${response.status}): ${text.slice(0, 200)}`,
        response.status
      );
    }

    const token = extractToken(body);
    if (!token) {
      throw new SubscriberTokenError(
        `SignalWire returned no recognisable token field. Body: ${text.slice(0, 200)}`,
        502
      );
    }

    return { token, expiresAt, raw: body };
  }
}

/** Builds a minter if the space credentials are present. */
export function createMinterFromEnv(
  env: NodeJS.ProcessEnv = process.env
): { minter: SubscriberTokenMinter } | { missing: string } {
  const { SIGNALWIRE_SPACE, SIGNALWIRE_PROJECT_ID, SIGNALWIRE_API_TOKEN, TOKEN_TTL_SECONDS } = env;

  if (!SIGNALWIRE_SPACE || !SIGNALWIRE_PROJECT_ID || !SIGNALWIRE_API_TOKEN) {
    return {
      missing:
        'subscriber tokens (needs SIGNALWIRE_SPACE, SIGNALWIRE_PROJECT_ID, SIGNALWIRE_API_TOKEN)'
    };
  }

  return {
    minter: new SubscriberTokenMinter({
      space: SIGNALWIRE_SPACE,
      projectId: SIGNALWIRE_PROJECT_ID,
      apiToken: SIGNALWIRE_API_TOKEN,
      ttlSeconds: parseTtl(TOKEN_TTL_SECONDS)
    })
  };
}

/** `TOKEN_TTL_SECONDS`: a whole number of seconds, at least 60; anything else is the default. */
export function parseTtl(value: string | undefined): number {
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 60 ? seconds : DEFAULT_TOKEN_TTL_SECONDS;
}
