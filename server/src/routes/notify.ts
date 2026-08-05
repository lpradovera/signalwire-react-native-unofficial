import { Router } from 'express';

import type { NotificationService } from '../core/NotificationService.js';

interface NotifyBody {
  externalUserId?: unknown;
  correlationId?: unknown;
  from?: unknown;
  fromName?: unknown;
}

/**
 * The generic send endpoint.
 *
 *   POST /notify  { externalUserId, correlationId, from?, fromName? }
 *
 * Backend-agnostic on purpose: the SignalWire webhook normalises into this,
 * and so would any other signalling source.
 */
export function createNotifyRoutes(service: NotificationService): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const { externalUserId, correlationId, from, fromName } = req.body as NotifyBody;

    if (typeof externalUserId !== 'string' || externalUserId.length === 0) {
      res.status(400).json({ error: 'externalUserId is required' });
      return;
    }
    if (typeof correlationId !== 'string' || correlationId.length === 0) {
      res.status(400).json({
        error:
          'correlationId is required — the client fuses the native call to the SDK call on it'
      });
      return;
    }

    const result = await service.notify({
      externalUserId,
      correlationId,
      from: typeof from === 'string' ? from : undefined,
      fromName: typeof fromName === 'string' ? fromName : undefined
    });

    res.json(result);
  });

  return router;
}
