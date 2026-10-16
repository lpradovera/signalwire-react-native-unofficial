/** What `watchPushToken` reports. */
export interface PushRegistration {
  platform: 'ios' | 'android';
  token: string;
}

/** The APNs host a PushKit token belongs to. */
export type ApnsEnvironment = 'sandbox' | 'production';

/**
 * The `aps-environment` of the build's provisioning profile, as
 * `expo-application`'s `getIosPushNotificationServiceEnvironmentAsync` reads
 * it: `null` when the app carries no profile.
 */
export type ApsEntitlement = 'development' | 'production' | null;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Maps the signing to the APNs environment the token belongs to.
 *
 * What decides it is the provisioning profile, not the build configuration: a
 * build signed with a development profile — Debug or Release — gets a sandbox
 * token, and Ad Hoc, TestFlight and App Store builds get production tokens. An
 * App Store install has no embedded profile at all, hence `null` → production.
 * A token sent to the other host fails with BadDeviceToken, and the server
 * then prunes the device as expired.
 */
export function apnsEnvironmentFor(entitlement: ApsEntitlement): ApnsEnvironment {
  return entitlement === 'development' ? 'sandbox' : 'production';
}

/** A registration the server answered with an error status. */
export class RegistrationError extends Error {
  constructor(
    readonly status: number,
    detail: string
  ) {
    super(`Device registration failed: ${status} ${detail}`.trim());
    this.name = 'RegistrationError';
  }
}

/** Posts one registration to the support server's `/devices`. */
export async function registerDevice({
  url,
  externalUserId,
  registration: { platform, token },
  environment,
  fetch = globalThis.fetch
}: {
  url: string;
  externalUserId: string;
  registration: PushRegistration;
  /** Sent for iOS only; FCM has no sandbox/production split. */
  environment: ApnsEnvironment;
  fetch?: FetchLike;
}): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      externalUserId,
      platform,
      token,
      ...(platform === 'ios' ? { environment } : {})
    })
  });
  if (!response.ok) {
    throw new RegistrationError(response.status, await response.text().catch(() => ''));
  }
}

/**
 * Whether a failed attempt can succeed unchanged later: the network, or the
 * server being down or overloaded. A 4xx otherwise means the request itself is
 * wrong, and sending it again changes nothing.
 */
function isRetryable(error: unknown): boolean {
  if (!(error instanceof RegistrationError)) {
    return true;
  }
  return error.status >= 500 || error.status === 408 || error.status === 429;
}

const DEFAULT_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];

/**
 * Runs `attempt` until it succeeds, waiting longer after each failure and then
 * repeating the longest delay. Returns a function that stops it.
 *
 * The platform hands over a token once per launch — `watchVoipToken` drops a
 * repeat of the same token — so without this a registration that failed once
 * (the server restarting, the network not up yet) left the device unregistered
 * for the whole session, with nothing on screen to say so.
 */
export function registerWithRetry(
  attempt: () => Promise<void>,
  {
    delaysMs = DEFAULT_DELAYS_MS,
    onError,
    schedule = (run, delayMs) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    }
  }: {
    delaysMs?: readonly number[];
    onError: (error: unknown, willRetry: boolean) => void;
    schedule?: (run: () => void, delayMs: number) => () => void;
  }
): () => void {
  let cancelled = false;
  let cancelTimer: (() => void) | null = null;
  let failures = 0;

  const run = (): void => {
    cancelTimer = null;
    attempt().catch((error: unknown) => {
      if (cancelled) {
        return;
      }
      const willRetry = isRetryable(error);
      onError(error, willRetry);
      if (!willRetry) {
        return;
      }
      const delay = delaysMs[Math.min(failures, delaysMs.length - 1)] ?? 0;
      failures += 1;
      cancelTimer = schedule(run, delay);
    });
  };

  run();

  return () => {
    cancelled = true;
    cancelTimer?.();
    cancelTimer = null;
  };
}
