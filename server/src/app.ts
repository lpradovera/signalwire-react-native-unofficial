import express from 'express';

import { createDeviceRoutes } from './routes/devices.js';
import { createNotifyRoutes } from './routes/notify.js';
import { createSignalWireWebhook } from './signalwire/webhook.js';

import type { DeviceStore } from './core/DeviceStore.js';
import type { NotificationService } from './core/NotificationService.js';
import type { Express, NextFunction, Request, Response, Router } from 'express';

export interface AppOptions {
  store: DeviceStore;
  service: NotificationService;
  /**
   * Shared secret required on every route except `/health` and `/token`. Omit
   * only for local development — this endpoint can send pushes to your whole
   * user base.
   */
  apiToken?: string;
  /**
   * Subscriber-token endpoint. Omitted when the space credentials are absent,
   * in which case `/token` 503s with an explanation rather than 404ing, so the
   * failure names the missing configuration.
   */
  tokenRoutes?: Router;
}

function requireApiToken(apiToken: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';

    // Length check first so the comparison below cannot leak length by timing.
    if (provided.length !== apiToken.length || provided !== apiToken) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}

/**
 * Builds the Express app without binding a port, so tests can drive it
 * directly. `src/index.ts` is the only place that listens.
 */
export function createApp({ store, service, apiToken, tokenRoutes }: AppOptions): Express {
  const app = express();

  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Before the shared-secret guard: the mobile app calls this directly and
  // cannot hold API_TOKEN. It carries its own auth — see routes/token.ts.
  if (tokenRoutes) {
    app.use('/token', tokenRoutes);
  } else {
    app.use('/token', (_req, res) => {
      res.status(503).json({
        error:
          'Subscriber tokens are not configured. Set SIGNALWIRE_SPACE, SIGNALWIRE_PROJECT_ID and SIGNALWIRE_API_TOKEN.'
      });
    });
  }

  if (apiToken) {
    app.use(requireApiToken(apiToken));
  }

  app.use('/devices', createDeviceRoutes(store));
  app.use('/notify', createNotifyRoutes(service));
  app.use('/webhooks/signalwire', createSignalWireWebhook(service));

  app.use((req, res) => {
    res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: error.message });
  });

  return app;
}
