import { Router } from 'express';

import type { DeviceStore } from '../core/DeviceStore.js';
import type { ApnsEnvironment, Platform } from '../core/types.js';
import type { AuthenticateCaller } from './token.js';
import type { Request, Response } from 'express';

const PLATFORMS: readonly string[] = ['ios', 'android'];
const ENVIRONMENTS: readonly string[] = ['sandbox', 'production'];

interface RegisterBody {
  externalUserId?: unknown;
  platform?: unknown;
  token?: unknown;
  environment?: unknown;
}

export interface DeviceRouteOptions {
  /**
   * Per-user authentication (`DEVICE_AUTH=caller`). Each request is
   * authenticated as one user by the same seam as `/token`, and may register,
   * list and delete only that user's devices; `externalUserId` in the body is
   * optional and must match. Omitted, the routes trust the body and are guarded
   * only by the shared `API_TOKEN` (an operator's or a backend's secret, not an
   * app's).
   */
  authenticateCaller?: AuthenticateCaller;
}

/**
 * Resolves the user a request acts for: the authenticated caller when
 * per-user auth is on, else the `claimed` id from the body (`null` if there is
 * none). Returns `undefined` after answering the request with 401 or 403.
 */
async function actingUser(
  req: Request,
  res: Response,
  authenticateCaller: AuthenticateCaller | undefined,
  claimed: unknown
): Promise<string | undefined | null> {
  if (!authenticateCaller) {
    return typeof claimed === 'string' && claimed.length > 0 ? claimed : null;
  }
  let user: string | null;
  try {
    user = await authenticateCaller(req);
  } catch {
    user = null;
  }
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return undefined;
  }
  if (claimed !== undefined && claimed !== user) {
    res.status(403).json({ error: 'externalUserId does not match the authenticated user' });
    return undefined;
  }
  return user;
}

/**
 * Device token registry.
 *
 *   POST   /devices          register or refresh a token
 *   DELETE /devices/:token   remove one (call this on sign-out)
 *   GET    /devices?externalUserId=…   list, for debugging
 *
 * With `authenticateCaller`, the user is the authenticated caller: GET lists
 * only their devices and DELETE removes only theirs (another user's token is
 * a 404, as if it did not exist).
 */
export function createDeviceRoutes(
  store: DeviceStore,
  { authenticateCaller }: DeviceRouteOptions = {}
): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const { externalUserId: claimed, platform, token, environment } = (req.body ?? {}) as RegisterBody;

    const externalUserId = await actingUser(req, res, authenticateCaller, claimed);
    if (externalUserId === undefined) {
      return;
    }
    if (externalUserId === null) {
      res.status(400).json({ error: 'externalUserId is required' });
      return;
    }
    if (typeof token !== 'string' || token.length === 0) {
      res.status(400).json({ error: 'token is required' });
      return;
    }
    if (typeof platform !== 'string' || !PLATFORMS.includes(platform)) {
      res.status(400).json({ error: 'platform must be "ios" or "android"' });
      return;
    }
    // iOS sandbox and production tokens are not interchangeable, so this is
    // required rather than defaulted — a wrong guess fails silently at Apple.
    if (platform === 'ios' && (typeof environment !== 'string' || !ENVIRONMENTS.includes(environment))) {
      res.status(400).json({ error: 'environment must be "sandbox" or "production" for iOS' });
      return;
    }

    const device = await store.register({
      externalUserId,
      platform: platform as Platform,
      token,
      environment: (typeof environment === 'string' ? environment : 'production') as ApnsEnvironment
    });

    res.status(201).json({ device });
  });

  router.delete('/:token', async (req, res) => {
    if (authenticateCaller) {
      const user = await actingUser(req, res, authenticateCaller, undefined);
      if (!user) {
        return;
      }
      const owned = (await store.findByUser(user)).some((device) => device.token === req.params.token);
      if (!owned) {
        res.status(404).end();
        return;
      }
    }
    const removed = await store.remove(req.params.token);
    res.status(removed ? 204 : 404).end();
  });

  router.get('/', async (req, res) => {
    if (authenticateCaller) {
      const user = await actingUser(req, res, authenticateCaller, undefined);
      if (user) {
        res.json({ devices: await store.findByUser(user) });
      }
      return;
    }
    const externalUserId = req.query.externalUserId;
    const devices =
      typeof externalUserId === 'string' ? await store.findByUser(externalUserId) : await store.all();
    res.json({ devices });
  });

  return router;
}
