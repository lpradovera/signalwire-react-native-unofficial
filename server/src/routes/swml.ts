import { Router } from 'express';

import type { BridgeTokenStore } from '../core/BridgeTokenStore.js';
import type { CallEnder } from '../signalwire/endCall.js';
import type { NotificationService } from '../core/NotificationService.js';
import type { Request } from 'express';

/** One `ring:` entry lasts this long; the park window is built from these. */
const RINGBACK_CHUNK_SECONDS = 15;
const DEFAULT_PARK_SECONDS = 60;

export interface SwmlRouteOptions {
  tokens: BridgeTokenStore;
  service: NotificationService;
  /**
   * Public base URL SignalWire can reach — a tunnel in development. Used to
   * build the ringback URL, which SignalWire fetches itself.
   */
  publicUrl?: string;
  /**
   * Maps a dialled destination to a subscriber reference.
   *
   * Once a phone number points at the park resource, `to` is an E.164 number
   * and nothing about it names a user — this is where that lookup goes. The
   * default reads an explicit hint, then {@link routes}, then a single
   * configured subscriber.
   */
  resolveSubscriber?: (req: Request) => string | undefined;
  /**
   * Destination → subscriber reference. Populated from `PARK_ROUTES`, e.g.
   * `+15551234567:rn-example,+15559998888:other-user`.
   */
  routes?: Record<string, string>;
  /** Overrides the generated ring tone with your own recording. */
  ringback?: string;
  /** How long a caller waits before being hung up. Default 60s. */
  parkSeconds?: number;
  /**
   * Ends the caller's leg when the device's leg ends.
   *
   * Hanging up on the device does not end the parked caller: that leg is not
   * returned to its script and is not hung up, so it stays connected to
   * nothing until something ends it. Without this the caller sits in silence.
   */
  callEnder?: CallEnder;
}

/**
 * Collects the user variables, wherever SignalWire put them.
 *
 * A destination dialled as `/public/x?bridgeToken=abc` arrives as
 * `params.vars.userVariables.bridgeToken` — nested one level deeper than the
 * obvious `params.vars`. Reading only the outer object found no token, so the
 * bridge hung up and the device's leg died with cause USER_BUSY, which names
 * neither the token nor the route.
 *
 * Every level is merged, most specific last, because this shape is observed
 * rather than documented: if it moves again, the other levels still match.
 */
function variablesFrom(body: Record<string, unknown>): Record<string, unknown> {
  const params = (body.params ?? body) as Record<string, unknown>;
  const vars = (params.vars ?? {}) as Record<string, unknown>;
  const nested = (vars.userVariables ?? params.userVariables ?? {}) as Record<string, unknown>;
  return { ...params, ...vars, ...nested };
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

/** Reads the caller's identity, which becomes the name on the CallKit screen. */
function callerFrom(body: Record<string, unknown>): { from?: string; fromName?: string } {
  const params = (body.params ?? body) as Record<string, unknown>;
  const call = (params.call ?? {}) as Record<string, unknown>;

  let from: string | undefined;
  for (const candidate of [call.from, params.from, params.From, params.from_number]) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      from = candidate;
      break;
    }
  }

  let fromName: string | undefined;
  for (const candidate of [call.from_name, params.from_name, params.CallerName, call.caller_name]) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      fromName = candidate;
      break;
    }
  }

  return { from, fromName };
}

/**
 * Reads the subscriber from the caller's address, for the bridge leg.
 *
 * A subscriber dials out as `/private/<reference>`; that reference is who the
 * bridge token must belong to.
 */
function subscriberFromCaller(body: Record<string, unknown>): string | undefined {
  const { from } = callerFrom(body);
  if (!from || !from.includes('/')) {
    return undefined;
  }
  const segments = (from.split('?')[0] ?? from).split('/').filter(Boolean);
  return segments[segments.length - 1];
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
function makeDefaultResolveSubscriber(routes: Record<string, string>) {
  return (req: Request): string | undefined => defaultResolveSubscriber(req, routes);
}

function defaultResolveSubscriber(
  req: Request,
  routes: Record<string, string> = {}
): string | undefined {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const params = (body.params ?? body) as Record<string, unknown>;
  const vars = variablesFrom(body);

  const hint = vars.subscriber ?? params.subscriber ?? req.query.subscriber;
  if (typeof hint === 'string' && hint.length > 0) {
    return hint;
  }

  const address = calledAddressFrom(body);
  if (address) {
    const withoutQuery = address.split('?')[0] ?? address;
    // Exact match first: a phone number is the whole destination, and matching
    // it loosely would route calls to the wrong person.
    const routed = routes[withoutQuery] ?? routes[address];
    if (routed) {
      return routed;
    }
  }

  const configured = process.env.DEV_SUBSCRIBER_REFERENCE;
  if (configured && configured.length > 0) {
    return configured;
  }

  if (!address) {
    return undefined;
  }
  // Last resort, and only meaningful for a Fabric address: a phone number has
  // no user in it, so this returns the number and the push goes nowhere.
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
  routes = {},
  ringback,
  parkSeconds = DEFAULT_PARK_SECONDS,
  callEnder,
  resolveSubscriber = makeDefaultResolveSubscriber(routes)
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

    const caller = callerFrom(body);
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
      // Read from the call params, not the request root: with a phone number
      // pointed at this resource, this is the caller ID the user sees on the
      // lock screen, and getting it from the wrong place shows "Unknown".
      from: caller.from ?? 'Unknown',
      fromName: caller.fromName ?? caller.from ?? 'Incoming call',
      data: { bridgeToken: token.token }
    });

    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
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
    // `play` has NO loop parameter — an early version passed `loops` and the
    // verb failed, dropping straight through to the hangup below, so the
    // caller was disconnected the instant they were answered. Repetition is
    // expressed by repeating entries in `urls`.
    //
    // `ring:<seconds>:<country>` is generated by SignalWire, so the common
    // case hosts no audio at all. PARK_RINGBACK_URL overrides it with your own
    // recording; the /swml/ringback route on this server serves a suitable one.
    const ringbackUrl = ringback ?? `ring:${RINGBACK_CHUNK_SECONDS.toFixed(1)}:us`;
    const chunks = Math.max(1, Math.ceil(parkSeconds / RINGBACK_CHUNK_SECONDS));

    res.json({
      version: '1.0.0',
      sections: {
        main: [
          { answer: {} },
          { play: { urls: Array.from({ length: chunks }, () => ringbackUrl) } },
          // Reached only if nobody answers within the park window: the caller
          // must not be held indefinitely.
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
    const vars = variablesFrom(body);

    const token = (vars.bridgeToken ?? vars.bridge_token ?? req.query.token) as string | undefined;
    // The subscriber here is the CALLER — the device redeeming its token —
    // not the destination. Resolving from `to` yields the bridge resource
    // ("rn-example-bridge"), so every token looks like it belongs to someone
    // else and is rejected as wrong-subscriber. A configured
    // DEV_SUBSCRIBER_REFERENCE hides this locally; nothing hides it in
    // production, where a single wrong name fails every bridge.
    const externalUserId =
      (vars.subscriber as string | undefined) ??
      subscriberFromCaller(body) ??
      resolveSubscriber(req);

    if (!token || !externalUserId) {
      // Logged with the request shape, not just the fact of failure. A device
      // dials `?bridgeToken=...`, so if the token is not in `vars` here then
      // SignalWire did not forward the query string the way we assumed — and
      // without this line that is indistinguishable from never being called
      // at all. The device only sees the leg end, with cause USER_BUSY.
      console.warn(
        JSON.stringify({
          message: 'Bridge request missing token or subscriber',
          hasToken: Boolean(token),
          externalUserId,
          varKeys: Object.keys(vars),
          paramKeys: Object.keys(params),
          query: req.query
        })
      );
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

    // Logged on the way out, not just on failure. Without this a successful
    // bridge is indistinguishable from one that never arrived: the route is
    // silent, so "SignalWire never called us" and "we bridged fine and the
    // problem is downstream" look identical from the log.
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        message: 'Bridged device to parked caller',
        callSid: redeemed.callSid,
        externalUserId
      })
    );

    // status_url, not an app-side callback: SignalWire knows when the bridge
    // ends, and it tells us even if the app was backgrounded, killed or lost
    // the network at the moment of hangup — all of which would otherwise
    // strand the caller on a live, silent leg forever.
    const statusUrl = publicUrl
      ? `${publicUrl.replace(/\/$/, '')}/swml/bridge/status?token=${encodeURIComponent(token)}`
      : undefined;

    if (!statusUrl) {
      console.warn(
        JSON.stringify({
          message: 'PUBLIC_URL unset; the caller leg will not be ended when the device hangs up',
          callSid: redeemed.callSid
        })
      );
    }

    res.json({
      version: '1.0.0',
      sections: {
        main: [
          {
            connect: {
              to: `call:${redeemed.callSid}`,
              ...(statusUrl ? { status_url: statusUrl } : {})
            }
          }
        ]
      }
    });
  });

  /**
   * Ends the caller's leg, when the device's leg has ended.
   *
   * Called by the app, not by SignalWire: nothing tells the server that the
   * device hung up, and the caller does not end on its own. Takes the same
   * single-use token the device already holds, so it names the call without
   * ever being told the call SID.
   */
  router.post('/bridge/end', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const vars = variablesFrom(body);
    const token = (vars.bridgeToken ?? vars.token ?? body.token) as string | undefined;
    const externalUserId =
      (vars.subscriber as string | undefined) ??
      subscriberFromCaller(body) ??
      resolveSubscriber(req);

    if (!token || !externalUserId) {
      res.status(400).json({ error: 'bridgeToken and subscriber are required' });
      return;
    }

    const paired = tokens.pairedCallSid(token, externalUserId);
    if ('error' in paired) {
      console.warn(
        JSON.stringify({ message: 'Bridge end rejected', reason: paired.error, externalUserId })
      );
      res.status(404).json({ error: paired.error });
      return;
    }

    if (!callEnder) {
      console.warn(
        JSON.stringify({
          message: 'No call ender configured; the caller leg will be left up',
          callSid: paired.callSid
        })
      );
      res.status(501).json({ error: 'call ender not configured' });
      return;
    }

    const result = await callEnder.end(paired.callSid);
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        message: result.ok ? 'Ended caller leg' : 'Failed to end caller leg',
        callSid: paired.callSid,
        externalUserId,
        ...(result.ok ? {} : { error: result.error })
      })
    );
    res.status(result.ok ? 200 : 502).json(result);
  });

  /**
   * Ends the caller's leg when the bridge disconnects.
   *
   * SignalWire posts `calling.call.connect` events here for the connect issued
   * by /swml/bridge. `disconnected` means the device's leg is gone — and the
   * caller's leg is not returned to its script and is not hung up, so without
   * this it stays up, connected to nothing, in silence.
   */
  router.post('/bridge/status', async (req, res) => {
    // Answer first. This is a status callback: SignalWire does not need our
    // opinion, and a slow REST call here should not hold up its pipeline.
    res.status(204).end();

    const body = (req.body ?? {}) as Record<string, unknown>;
    const params = (body.params ?? {}) as Record<string, unknown>;
    const state = params.connect_state;
    const token = req.query.token as string | undefined;


    if (state !== 'disconnected' && state !== 'failed') {
      return;
    }
    if (!token) {
      console.warn(JSON.stringify({ message: 'Bridge status callback carried no token', state }));
      return;
    }

    const paired = tokens.pairedCallSidByToken(token);
    if (!paired) {
      console.warn(JSON.stringify({ message: 'Bridge status: unknown token', state }));
      return;
    }

    if (!callEnder) {
      console.warn(
        JSON.stringify({
          message: 'No call ender configured; the caller leg will be left up',
          callSid: paired.callSid
        })
      );
      return;
    }

    const result = await callEnder.end(paired.callSid);
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        message: result.ok ? 'Ended caller leg' : 'Failed to end caller leg',
        callSid: paired.callSid,
        connectState: state,
        ...(result.ok ? {} : { error: result.error })
      })
    );
  });

  return router;
}
