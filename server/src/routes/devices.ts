import { Router } from 'express';

import type { DeviceStore } from '../core/DeviceStore.js';
import type { ApnsEnvironment, Platform } from '../core/types.js';

const PLATFORMS: readonly string[] = ['ios', 'android'];
const ENVIRONMENTS: readonly string[] = ['sandbox', 'production'];

interface RegisterBody {
  externalUserId?: unknown;
  platform?: unknown;
  token?: unknown;
  environment?: unknown;
}

/**
 * Device token registry.
 *
 *   POST   /devices          register or refresh a token
 *   DELETE /devices/:token   remove one (call this on sign-out)
 *   GET    /devices?externalUserId=…   list, for debugging
 */
export function createDeviceRoutes(store: DeviceStore): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const { externalUserId, platform, token, environment } = req.body as RegisterBody;

    if (typeof externalUserId !== 'string' || externalUserId.length === 0) {
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
    const removed = await store.remove(req.params.token);
    res.status(removed ? 204 : 404).end();
  });

  router.get('/', async (req, res) => {
    const externalUserId = req.query.externalUserId;
    const devices =
      typeof externalUserId === 'string' ? await store.findByUser(externalUserId) : await store.all();
    res.json({ devices });
  });

  return router;
}
