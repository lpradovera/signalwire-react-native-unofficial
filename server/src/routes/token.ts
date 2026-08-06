import { Router } from 'express';

import { SubscriberTokenError } from '../signalwire/subscriberTokens.js';

import type { SubscriberTokenMinter } from '../signalwire/subscriberTokens.js';
import type { Request } from 'express';

/**
 * Decides which subscriber the caller is allowed a token for.
 *
 * **This is the seam you replace.** In a real deployment the app sends its own
 * session credential and you map that to your user record — exactly as you
 * already do for every other authenticated request. Return the subscriber
 * reference, or `null` to reject.
 *
 * The client must never choose its own reference: whoever picks the reference
 * picks whose calls they receive.
 */
export type AuthenticateCaller = (req: Request) => Promise<string | null> | string | null;

export interface TokenRouteOptions {
  minter: SubscriberTokenMinter;
  authenticateCaller: AuthenticateCaller;
}

/**
 * Subscriber token endpoint.
 *
 *   POST /token   ->  { token, reference }
 *
 * Mounted before the shared `API_TOKEN` guard because the mobile app calls it
 * directly, and an app cannot hold that shared secret — anyone who unzips the
 * bundle would be able to push to every registered device.
 */
export function createTokenRoutes({ minter, authenticateCaller }: TokenRouteOptions): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    let reference: string | null;
    try {
      reference = await authenticateCaller(req);
    } catch {
      reference = null;
    }

    if (!reference) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const { token } = await minter.mint(reference);
      res.json({ token, reference });
    } catch (error) {
      if (error instanceof SubscriberTokenError) {
        // 5xx from SignalWire is not the caller's fault; surface it as a gateway
        // error so a client retry policy can tell the two apart.
        res.status(error.status >= 500 ? 502 : error.status).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: (error as Error).message });
    }
  });

  return router;
}

/**
 * Development stand-in for {@link AuthenticateCaller}: accepts anyone and reads
 * the reference from the request, defaulting to `DEV_SUBSCRIBER_REFERENCE`.
 *
 * Enabled only by `ALLOW_UNAUTHENTICATED_TOKENS=1`, and `index.ts` logs loudly
 * when it is on. Never deploy with it: it lets any caller mint a token for any
 * subscriber in your space.
 */
export function createDevAuthenticateCaller(defaultReference: string): AuthenticateCaller {
  return (req) => {
    const body = req.body as { reference?: unknown } | undefined;
    return typeof body?.reference === 'string' && body.reference.length > 0
      ? body.reference
      : defaultReference;
  };
}
