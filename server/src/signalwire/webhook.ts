import { Router } from 'express';

import type { NotificationService } from '../core/NotificationService.js';
import type { CallNotification } from '../core/types.js';

/**
 * The one SignalWire-aware file in this server.
 *
 * Everything under `src/core/` is deliberately generic; this adapter maps a
 * SignalWire inbound-call webhook onto {@link CallNotification}. Keeping the
 * split means the rest is extractable as a standalone push service.
 *
 * ⚠️ THE EXACT PAYLOAD SHAPE IS UNVERIFIED. SignalWire's webhook for an
 * inbound call to a Fabric subscriber was not confirmed while this was
 * written, so `mapPayload` accepts several plausible field names and logs what
 * it received. Point a real webhook at it, read the log, then delete the
 * guesses and keep the branch that fires.
 */

interface RawWebhookBody {
  [key: string]: unknown;
}

function firstString(body: RawWebhookBody, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/** Maps a raw webhook body onto the generic notification shape. */
export function mapPayload(body: RawWebhookBody): CallNotification | { error: string } {
  const params = (body.params ?? body) as RawWebhookBody;

  const correlationId = firstString(params, ['call_id', 'callId', 'id']);
  const externalUserId = firstString(params, [
    'to_subscriber_id',
    'subscriber_id',
    'subscriberId',
    'to'
  ]);

  if (!correlationId) {
    return { error: 'Could not find a call id on the webhook payload' };
  }
  if (!externalUserId) {
    return { error: 'Could not find the callee on the webhook payload' };
  }

  return {
    correlationId,
    externalUserId,
    from: firstString(params, ['from', 'caller_id_number', 'from_number']),
    fromName: firstString(params, ['from_name', 'caller_id_name', 'fromName'])
  };
}

export function createSignalWireWebhook(
  service: NotificationService,
  log: (message: string, meta?: Record<string, unknown>) => void = () => undefined
): Router {
  const router = Router();

  router.post('/inbound', async (req, res) => {
    const mapped = mapPayload(req.body as RawWebhookBody);

    if ('error' in mapped) {
      // Log the whole body so the field names can be read off a real call.
      log('Unmapped SignalWire webhook', { body: req.body, reason: mapped.error });
      res.status(422).json({ error: mapped.error, received: req.body });
      return;
    }

    // Respond before pushing would be better under load; kept inline here so
    // the scaffold surfaces delivery failures while you are wiring it up.
    const result = await service.notify(mapped);
    res.json(result);
  });

  return router;
}
