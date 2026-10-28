/** What the support server's `POST /token` answers. */
export interface ServerToken {
  token: string;
  /** The subscriber the token was minted for, which the server decides. */
  reference: string;
  /** When the token expires (Unix seconds), as the server reports it. */
  expiresAt?: number;
}

/** A refusal from the token server, with its HTTP status. */
export class ServerTokenError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ServerTokenError';
    this.status = status;
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Requests a subscriber token from the support server.
 *
 * The status is checked before the body is parsed: a tunnel or proxy in front
 * of a stopped server answers with an HTML error page, and parsing that first
 * reported a JSON syntax error instead of the status that says the server is
 * down. The request has a timeout of its own because React Native's Android
 * client has none, and an unreachable address otherwise waits for the OS's TCP
 * connect timeout.
 *
 * The reference comes back from the server, not from the request: it is the
 * server that decides whose token this is, and the device must register for
 * push under exactly that subscriber.
 */
export async function requestServerToken(
  url: string,
  reference: string,
  { fetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }: { fetch?: FetchLike; timeoutMs?: number } = {}
): Promise<ServerToken> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reference }),
      signal: controller.signal
    });
    text = await response.text();
  } catch (error) {
    if (timedOut) {
      throw new Error(`Token server did not answer within ${timeoutMs / 1000} s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const body = parseObject(text);
  if (!response.ok) {
    const detail = typeof body?.error === 'string' ? `: ${body.error}` : '';
    throw new ServerTokenError(`Token server returned ${response.status}${detail}`, response.status);
  }
  if (typeof body?.token !== 'string' || body.token.length === 0) {
    throw new Error('Token server returned no token');
  }
  return {
    token: body.token,
    reference: typeof body.reference === 'string' && body.reference ? body.reference : reference,
    ...(typeof body.expires_at === 'number' ? { expiresAt: body.expires_at } : {})
  };
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
