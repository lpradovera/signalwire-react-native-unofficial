import { Router } from 'express';

import type { BridgeTokenStore } from '../core/BridgeTokenStore.js';
import type { NotificationService } from '../core/NotificationService.js';
import type { Request } from 'express';

export interface SwmlRouteOptions {
  tokens: BridgeTokenStore;
  service: NotificationService;
  /**
   * Public base URL SignalWire can reach — a tunnel in development. Used to
   * build the ringback URL, which SignalWire fetches itself.
   */
  publicUrl?: string;
  /**
   * Maps the dialled address to a subscriber reference. Defaults to the last
   * path segment, so `/private/rn-example` resolves to `rn-example`.
   */
  resolveSubscriber?: (req: Request) => string | undefined;
}

/** Reads the call SID from whichever field SignalWire used. */
function callSidFrom(body: Record<string, unknown>): string | undefined {
  const params = (body.params ?? body) as Record<string, unknown>;
  const call = (params.call ?? {}) as Record<string, unknown>;
  for (const candidate of [call.call_id, call.id, params.call_id, params.callSid, params.CallSid]) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

/** Reads the dialled destination, to decide who to ring. */
function calledAddressFrom(body: Record<string, unknown>): string | undefined {
  const params = (body.params ?? body) as Record<string, unknown>;
  const call = (params.call ?? {}) as Record<string, unknown>;
  for (const candidate of [call.to, params.to, params.To, params.to_number]) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Works out which subscriber a parked call is for.
 *
 * NOT the dialled address: callers dial the park resource, whose name says
 * nothing about who should be rung — resolving from it produced a push
 * addressed to "rn-example-park", a subscriber that does not exist, and
 * `delivered: 0` with no error anywhere.
 *
 * A real deployment maps the dialled number, or a per-user resource, to a user
 * record. Replace this; the scaffold takes an explicit hint and falls back to a
 * single configured subscriber so one device can be tested end to end.
 */
function defaultResolveSubscriber(req: Request): string | undefined {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const params = (body.params ?? body) as Record<string, unknown>;
  const vars = (params.vars ?? params.userVariables ?? {}) as Record<string, unknown>;

  const hint = vars.subscriber ?? params.subscriber ?? req.query.subscriber;
  if (typeof hint === 'string' && hint.length > 0) {
    return hint;
  }

  const configured = process.env.DEV_SUBSCRIBER_REFERENCE;
  if (configured && configured.length > 0) {
    return configured;
  }

  const address = calledAddressFrom(body);
  if (!address) {
    return undefined;
  }
  const withoutQuery = address.split('?')[0] ?? address;
  const segments = withoutQuery.split('/').filter(Boolean);
  return segments[segments.length - 1];
}

/**
 * SWML for the parked-caller inbound flow.
 *
 *   POST /swml/park     answer the caller, wake the device, hold on ringback
 *   POST /swml/bridge   the woken device redeems its token and is joined
 *
 * The shape exists because of a timing problem: a device woken by push needs
 * seconds to launch, fetch a token, open a WebSocket and authenticate, and an
 * invite that arrives before that simply fails. Parking the caller removes the
 * race entirely rather than tuning it — the caller waits on ringback, and the
 * device joins whenever it is ready.
 */
export function createSwmlRoutes({
  tokens,
  service,
  publicUrl,
  resolveSubscriber = defaultResolveSubscriber
}: SwmlRouteOptions): Router {
  const router = Router();

  router.post('/park', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const callSid = callSidFrom(body);
    const externalUserId = resolveSubscriber(req);

    if (!callSid || !externalUserId) {
      // Answering and hanging up beats returning an error: the caller hears
      // something deliberate, and the log says exactly what was missing.
      console.warn(
        JSON.stringify({
          message: 'Park request missing call SID or subscriber; hanging up',
          hasCallSid: Boolean(callSid),
          externalUserId,
          body
        })
      );
      res.json({ version: '1.0.0', sections: { main: [{ hangup: {} }] } });
      return;
    }

    const token = tokens.mint(callSid, externalUserId);

    // Push before the SWML is returned, so the device is already waking while
    // the caller hears the first ring.
    const result = await service.notify({
      externalUserId,
      // The token, NOT the call SID: correlationId becomes `call_id` in the
      // push payload, so putting the SID here would ship the very capability
      // this indirection exists to withhold. The SID stays in the log line
      // below, which never leaves the server.
      correlationId: token.token,
      from: (body.from as string) ?? 'Unknown',
      fromName: (body.fromName as string) ?? 'Incoming call',
      data: { bridgeToken: token.token }
    });

    console.log(
      JSON.stringify({
        message: 'Parked caller and pushed',
        callSid,
        externalUserId,
        delivered: result.delivered,
        attempted: result.attempted
      })
    );

    // `ring:` is generated by SignalWire, so no audio needs hosting. The loop
    // is bounded: a declined or unanswered call must not park forever, and the
    // hangup after it is what ends the caller's leg cleanly.
    // Served from this server so nothing external has to host audio. Falls
    // back to SignalWire-generated tone when no public URL is configured,
    // because a device-local URL is useless to SignalWire.
    const ringback = publicUrl ? `${publicUrl.replace(/\/+$/, '')}/swml/ringback` : 'ring:2:us';

    res.json({
      version: '1.0.0',
      sections: {
        main: [
          { answer: {} },
          { play: { url: ringback, loops: 15 } },
          { hangup: { reason: 'busy' } }
        ]
      }
    });
  });

  /**
   * Ringback tone, synthesised rather than shipped.
   *
   * North American ringback: 440 Hz + 480 Hz for 2s, then 4s of silence. A
   * generated file avoids committing a binary asset and keeps the tone
   * self-describing — the numbers above are the specification.
   */
  router.get('/ringback', (_req, res) => {
    const sampleRate = 8000;
    const onSeconds = 2;
    const offSeconds = 4;
    const total = (onSeconds + offSeconds) * sampleRate;
    const samples = Buffer.alloc(total * 2);

    for (let i = 0; i < total; i++) {
      let value = 0;
      if (i < onSeconds * sampleRate) {
        const t = i / sampleRate;
        // Half amplitude each so the sum cannot clip.
        value =
          Math.sin(2 * Math.PI * 440 * t) * 0.25 + Math.sin(2 * Math.PI * 480 * t) * 0.25;
      }
      samples.writeInt16LE(Math.round(value * 32767), i * 2);
    }

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + samples.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(samples.length, 40);

    res.setHeader('content-type', 'audio/wav');
    res.send(Buffer.concat([header, samples]));
  });

  router.post('/bridge', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const params = (body.params ?? body) as Record<string, unknown>;
    const vars = (params.vars ?? params.userVariables ?? params) as Record<string, unknown>;

    const token = (vars.bridgeToken ?? vars.bridge_token ?? req.query.token) as string | undefined;
    const externalUserId = resolveSubscriber(req) ?? (vars.subscriber as string | undefined);

    if (!token || !externalUserId) {
      res.json({ version: '1.0.0', sections: { main: [{ hangup: {} }] } });
      return;
    }

    const redeemed = tokens.redeem(token, externalUserId);
    if ('error' in redeemed) {
      // Logged with the reason because these are indistinguishable from the
      // device: a caller who hung up, a slow answer, and a replayed token all
      // look the same there.
      console.warn(
        JSON.stringify({ message: 'Bridge token rejected', reason: redeemed.error, externalUserId })
      );
      res.json({ version: '1.0.0', sections: { main: [{ hangup: {} }] } });
      return;
    }

    res.json({
      version: '1.0.0',
      sections: {
        main: [{ connect: { to: `call:${redeemed.callSid}` } }]
      }
    });
  });

  return router;
}
