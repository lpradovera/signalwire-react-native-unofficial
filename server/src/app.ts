import express from 'express';

import { createDeviceRoutes } from './routes/devices.js';
import { createNotifyRoutes } from './routes/notify.js';
import { createSignalWireWebhook } from './signalwire/webhook.js';

import type { DeviceStore } from './core/DeviceStore.js';
import type { NotificationService } from './core/NotificationService.js';
import type { Express, NextFunction, Request, Response } from 'express';

export interface AppOptions {
  store: DeviceStore;
  service: NotificationService;
  /**
   * Shared secret required on every route except `/health`. Omit only for
   * local development — this endpoint can send pushes to your whole user base.
   */
  apiToken?: string;
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
export function createApp({ store, service, apiToken }: AppOptions): Express {
  const app = express();

  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

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
