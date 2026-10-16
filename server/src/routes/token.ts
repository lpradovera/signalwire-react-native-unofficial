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
 *   POST /token   ->  { token, reference, expires_at }
 *
 * `expires_at` is when the token stops working, in Unix seconds
 * (`TOKEN_TTL_SECONDS` after minting). The app renews before then.
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
      const { token, expiresAt } = await minter.mint(reference);
      res.json({ token, reference, expires_at: expiresAt });
    } catch (error) {
      if (error instanceof SubscriberTokenError) {
        // Nothing SignalWire refuses here is the app's fault: the caller was
        // already authenticated above, and the request upstream carries this
        // server's project credentials and its own reference. So every
        // upstream failure is a gateway error. Passing a 401 through would
        // read to the app as its own login failing.
        const hint =
          error.status === 401 || error.status === 403
            ? ' Check this server\'s SIGNALWIRE_PROJECT_ID, SIGNALWIRE_API_TOKEN and SIGNALWIRE_SPACE.'
            : '';
        res.status(502).json({ error: `${error.message}${hint}` });
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
    // `reference` is what /token is sent; `externalUserId` is what /devices is
    // sent (with DEVICE_AUTH=caller). Either names the caller, unchecked.
    const body = req.body as { reference?: unknown; externalUserId?: unknown } | undefined;
    for (const claimed of [body?.reference, body?.externalUserId]) {
      if (typeof claimed === 'string' && claimed.length > 0) {
        return claimed;
      }
    }
    return defaultReference;
  };
}
