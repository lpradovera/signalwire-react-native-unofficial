import { createHash, timingSafeEqual } from 'node:crypto';

import express from 'express';

import { createDeviceRoutes } from './routes/devices.js';
import { createNotifyRoutes } from './routes/notify.js';
import { captureRawBody } from './signalwire/signature.js';
import { createSignalWireWebhook } from './signalwire/webhook.js';

import type { DeviceStore } from './core/DeviceStore.js';
import type { NotificationService } from './core/NotificationService.js';
import type { AuthenticateCaller } from './routes/token.js';
import type { Express, NextFunction, Request, RequestHandler, Response, Router } from 'express';

export interface AppOptions {
  store: DeviceStore;
  service: NotificationService;
  /**
   * Shared secret for `/notify`, and for `/devices` and the SignalWire webhook
   * unless `deviceAuth` / `signalWireSignature` authenticate them instead. Not
   * required on `/health`, `/token` or `/swml/*`. Omit only for local
   * development — this endpoint can send pushes to your whole user base.
   */
  apiToken?: string;
  /**
   * Per-user auth for `/devices` (`DEVICE_AUTH=caller`): the same seam as
   * `/token`. Set, `/devices` is mounted before the `API_TOKEN` guard, and each
   * request may touch only the authenticated user's devices. This is what lets
   * an app register itself without holding `API_TOKEN`.
   */
  deviceAuth?: AuthenticateCaller;
  /**
   * SignalWire signature check (`SIGNALWIRE_SIGNING_KEY`). Set, the SignalWire
   * webhook is mounted before the `API_TOKEN` guard behind this check, since
   * SignalWire signs its requests and cannot send a bearer token.
   */
  signalWireSignature?: RequestHandler;
  /** Structured log line, for the webhook's diagnostics. */
  log?: (message: string, meta?: Record<string, unknown>) => void;
  /**
   * Subscriber-token endpoint. Omitted when the space credentials are absent,
   * in which case `/token` 503s with an explanation rather than 404ing, so the
   * failure names the missing configuration.
   */
  tokenRoutes?: Router;
  /**
   * SWML for the parked-caller inbound flow. Mounted outside the API-token
   * guard: SignalWire fetches these, and it has no way to present that secret.
   * They authorise on their own terms — SignalWire's request signature when a
   * signing key is configured, and a single-use bridge token scoped to one
   * subscriber. See routes/swml.ts.
   */
  swmlRoutes?: Router;
}

const defaultLog = (message: string, meta?: Record<string, unknown>): void => {
  console.error(JSON.stringify({ at: new Date().toISOString(), message, ...meta }));
};

/**
 * Compares two secrets in time that depends on neither. Both are hashed
 * first, so the comparison is always of 32 bytes and reveals no length.
 */
function sameSecret(provided: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

function requireApiToken(apiToken: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';

    if (!sameSecret(provided, apiToken)) {
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
export function createApp({
  store,
  service,
  apiToken,
  deviceAuth,
  signalWireSignature,
  log,
  tokenRoutes,
  swmlRoutes
}: AppOptions): Express {
  const app = express();

  // The raw body is kept for SignalWire signature checks, which cover the
  // bytes as sent rather than the parsed JSON.
  app.use(express.json({ limit: '64kb', verify: captureRawBody }));

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

  if (swmlRoutes) {
    app.use('/swml', swmlRoutes);
  }

  // Routes that authenticate on their own terms come before the shared guard.
  if (deviceAuth) {
    app.use('/devices', createDeviceRoutes(store, { authenticateCaller: deviceAuth }));
  }
  if (signalWireSignature) {
    app.use('/webhooks/signalwire', signalWireSignature, createSignalWireWebhook(service, log));
  }

  if (apiToken) {
    app.use(requireApiToken(apiToken));
  }

  if (!deviceAuth) {
    app.use('/devices', createDeviceRoutes(store));
  }
  app.use('/notify', createNotifyRoutes(service));
  if (!signalWireSignature) {
    // Without a signing key the webhook stays behind API_TOKEN, which
    // SignalWire cannot send: only a caller you control (your own RELAY app,
    // or SWML with custom headers) can reach it then.
    app.use('/webhooks/signalwire', createSignalWireWebhook(service, log));
  }

  app.use((req, res) => {
    res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((error: Error & { status?: number; expose?: boolean }, req: Request, res: Response, _next: NextFunction) => {
    // body-parser marks its own errors (malformed JSON 400, too large 413,
    // bad charset 415) with a status and `expose`: those are the client's
    // mistake and say so. Anything else is ours: log it, and do not hand
    // internal details (paths, upstream bodies) to whoever sent the request.
    const status = typeof error.status === 'number' && error.status >= 400 && error.status < 500 ? error.status : 500;
    if (status < 500 && error.expose) {
      res.status(status).json({ error: error.message });
      return;
    }
    (log ?? defaultLog)('Request failed', { method: req.method, path: req.path, error: error.message });
    res.status(status).json({ error: status < 500 ? 'Bad request' : 'Internal server error' });
  });

  return app;
}
