import { Router } from 'express';

import { requireSignalWireSignature } from '../signalwire/signature.js';

import type { BridgeTokenStore } from '../core/BridgeTokenStore.js';
import type { CallEnder } from '../signalwire/endCall.js';
import type { NotificationService } from '../core/NotificationService.js';
import type { NotifyResult } from '../core/types.js';
import type { NextFunction, Request, Response } from 'express';

/** One `ring:` entry lasts this long; the park window is built from these. */
const RINGBACK_CHUNK_SECONDS = 15;
const DEFAULT_PARK_SECONDS = 60;
/**
 * How long the park reply waits on the push. Long enough for a normal APNs or
 * FCM round trip (well under a second) plus a cold OAuth exchange; short
 * enough that a stalled provider does not hold SignalWire's SWML fetch, and
 * with it the caller, in silence.
 */
const DEFAULT_PUSH_WAIT_MS = 5_000;

export interface SwmlRouteOptions {
  tokens: BridgeTokenStore;
  service: NotificationService;
  /**
   * Public base URL SignalWire can reach — a tunnel in development. Used to
   * build the bridge's status_url, and as the base of the URL SignalWire
   * signed when {@link signingKey} is set.
   */
  publicUrl?: string;
  /**
   * The space's Signing Key (`SIGNALWIRE_SIGNING_KEY`). When set, /park,
   * /bridge and /bridge/status refuse any request SignalWire did not sign.
   * Unset, anyone who can reach this server can ring any subscriber with a
   * caller ID of their choosing. Requires {@link publicUrl}.
   */
  signingKey?: string;
  /**
   * Maps a dialled destination to a subscriber reference.
   *
   * Once a phone number points at the park resource, `to` is an E.164 number
   * and nothing about it names a user — this is where that lookup goes. The
   * default reads `?subscriber=` on the handler URL, then {@link routes},
   * then `DEV_SUBSCRIBER_REFERENCE`, then the last path segment.
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
  /** How long the park reply waits on the push. Default 5s. */
  pushWaitMs?: number;
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

/** SignalWire's request: `params` (or the body itself), and `params.call`. */
function paramsAndCall(body: Record<string, unknown>): {
  params: Record<string, unknown>;
  call: Record<string, unknown>;
} {
  const params = (body.params ?? body) as Record<string, unknown>;
  return { params, call: (params.call ?? {}) as Record<string, unknown> };
}

/** The first non-empty string among `candidates`. */
function firstString(candidates: readonly unknown[]): string | undefined {
  return candidates.find((value): value is string => typeof value === 'string' && value.length > 0);
}

/** Reads the call SID from whichever field SignalWire used. */
function callSidFrom(body: Record<string, unknown>): string | undefined {
  const { params, call } = paramsAndCall(body);
  return firstString([call.call_id, call.id, params.call_id, params.callSid, params.CallSid]);
}

/** Reads the caller's identity, which becomes the name on the CallKit screen. */
function callerFrom(body: Record<string, unknown>): { from?: string; fromName?: string } {
  const { params, call } = paramsAndCall(body);
  return {
    from: firstString([call.from, params.from, params.From, params.from_number]),
    fromName: firstString([call.from_name, params.from_name, params.CallerName, call.caller_name])
  };
}

/**
 * Reads the subscriber from the caller's address, for the bridge leg.
 *
 * A subscriber dials out as `/private/<reference>`; that reference is who the
 * bridge token must belong to.
 */
function subscriberFromCaller(body: Record<string, unknown>): string | undefined {
  const { from } = callerFrom(body);
  if (!from) {
    return undefined;
  }

  // A subscriber dialling out appears as a SIP URI, not a Fabric address:
  //   sip:rn-android@<project>.call.signalwire.com;context=private
  // The reference is the user part. Reading only the `/private/<ref>` form
  // found nothing here, so the caller looked unidentifiable and the bridge
  // fell back to a configured default — which rejected a perfectly good token
  // as wrong-subscriber.
  // SIP and Fabric addresses escape what they cannot hold (an email's "@",
  // a space), while the token was minted for the reference as written, so
  // compare the unescaped form.
  if (from.startsWith('sip:')) {
    const user = unescapeReference(from.slice(4).split('@')[0]);
    return user && user.length > 0 ? user : undefined;
  }

  if (!from.includes('/')) {
    return undefined;
  }
  const segments = (from.split('?')[0] ?? from).split('/').filter(Boolean);
  return unescapeReference(segments[segments.length - 1]);
}

/** Percent-decodes a reference; one that is not valid escaping is kept as is. */
function unescapeReference(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Reads the dialled destination, to decide who to ring. */
function calledAddressFrom(body: Record<string, unknown>): string | undefined {
  const { params, call } = paramsAndCall(body);
  return firstString([call.to, params.to, params.To, params.to_number]);
}

/**
 * Works out which subscriber a parked call is for.
 *
 * NOT the dialled address: callers dial the park resource, whose name says
 * nothing about who should be rung — resolving from it produced a push
 * addressed to "rn-example-park", a subscriber that does not exist, and
 * `delivered: 0` with no error anywhere.
 *
 * NOT anything the caller sent either. A destination dialled as
 * `/public/park?subscriber=victim` arrives with its query copied into the
 * user variables, so reading a hint from the request body let any caller pick
 * whom to ring. The hint is read from this handler's own URL — the one set on
 * the SignalWire resource, and covered by its signature — and nowhere else.
 *
 * Order: `?subscriber=` on the handler URL, then `routes` (PARK_ROUTES), then
 * `DEV_SUBSCRIBER_REFERENCE`, then the last path segment of the destination.
 *
 * A real deployment maps the dialled number, or a per-user resource, to a user
 * record. Replace this; the scaffold falls back to a single configured
 * subscriber so one device can be tested end to end.
 */
function makeDefaultResolveSubscriber(routes: Record<string, string>) {
  return (req: Request): string | undefined => defaultResolveSubscriber(req, routes);
}

function defaultResolveSubscriber(
  req: Request,
  routes: Record<string, string> = {}
): string | undefined {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const hint = req.query.subscriber;
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
  pushWaitMs = DEFAULT_PUSH_WAIT_MS,
  callEnder,
  signingKey,
  resolveSubscriber = makeDefaultResolveSubscriber(routes)
}: SwmlRouteOptions): Router {
  const router = Router();

  if (signingKey && !publicUrl) {
    // The signature covers the URL SignalWire requested — the tunnel — not
    // the one this process sees, so it cannot be checked without it.
    throw new Error('A SignalWire signing key needs the public URL it signs: set PUBLIC_URL.');
  }
  const signedBySignalWire = signingKey && publicUrl
    ? requireSignalWireSignature({ signingKey, publicUrl })
    : (_req: Request, _res: Response, next: NextFunction) => next();

  router.post('/park', signedBySignalWire, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const callSid = callSidFrom(body);
    const externalUserId = resolveSubscriber(req);

    if (!callSid || !externalUserId) {
      // Answering and hanging up beats returning an error: the caller hears
      // something deliberate, and the log says exactly what was missing.
      console.warn(
        JSON.stringify({
          at: new Date().toISOString(),
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
    // the caller hears the first ring — but wait only so long: the caller
    // hears nothing at all until this reply goes out.
    const pushed = service.notify({
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
    const logPush = (result: NotifyResult | Error, late: boolean): void => {
      console.log(
        JSON.stringify({
          at: new Date().toISOString(),
          message: late ? 'Push finished after the park replied' : 'Parked caller and pushed',
          callSid,
          externalUserId,
          ...(result instanceof Error
            ? { error: result.message }
            : { delivered: result.delivered, attempted: result.attempted })
        })
      );
    };
    const settled = pushed.then(
      (result) => result,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
    );
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      settled,
      new Promise<'pending'>((resolve) => {
        timer = setTimeout(() => resolve('pending'), pushWaitMs);
      })
    ]);
    clearTimeout(timer);

    if (outcome === 'pending') {
      // Not known to have failed, so park as usual; log the result when it lands.
      console.warn(
        JSON.stringify({
          at: new Date().toISOString(),
          message: 'Push still in flight; parking the caller without waiting',
          callSid,
          externalUserId,
          waitedMs: pushWaitMs
        })
      );
      void settled.then((result) => logPush(result, true));
    } else if (outcome instanceof Error || outcome.delivered === 0) {
      // No device will ring, so nobody can answer. Answering would bill the
      // caller's leg and play a minute of ringback for no one; hanging up
      // unanswered turns the call away now.
      console.warn(
        JSON.stringify({
          at: new Date().toISOString(),
          message: 'Push reached no device; turning the caller away',
          callSid,
          externalUserId,
          ...(outcome instanceof Error
            ? { error: outcome.message }
            : { delivered: outcome.delivered, attempted: outcome.attempted })
        })
      );
      res.json({ version: '1.0.0', sections: { main: [{ hangup: { reason: 'busy' } }] } });
      return;
    } else {
      logPush(outcome, false);
    }

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

  router.post('/bridge', signedBySignalWire, (req, res) => {
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
    // Deliberately NOT resolveSubscriber(): its last resort is a single
    // configured subscriber, and guessing here does active harm. A token
    // minted for one subscriber was checked against that default and rejected
    // as wrong-subscriber — which only stayed invisible while the default
    // happened to match the only device being tested.
    // Nor a `subscriber` variable: the dialled query is the caller's to
    // write, so naming the token's owner there would skip the check below.
    const externalUserId = subscriberFromCaller(body);

    if (!token) {
      // Logged with the request shape, not just the fact of failure. A device
      // dials `?bridgeToken=...`, so if the token is not in `vars` here then
      // SignalWire did not forward the query string the way we assumed — and
      // without this line that is indistinguishable from never being called
      // at all. The device only sees the leg end, with cause USER_BUSY.
      console.warn(
        JSON.stringify({
          at: new Date().toISOString(),
          message: 'Bridge request missing its token',
          varKeys: Object.keys(vars),
          paramKeys: Object.keys(params),
          query: req.query
        })
      );
      res.json({ version: '1.0.0', sections: { main: [{ hangup: {} }] } });
      return;
    }

    // Redeemed against the caller when we can identify them, and on the token
    // alone when we cannot. The token is the capability: single-use,
    // unguessable and short-lived. Binding it to a subscriber is
    // defence-in-depth, and worth keeping where the request says who is
    // calling — but rejecting a valid token because the caller could not be
    // identified strands the call for no security gain.
    const redeemed = externalUserId
      ? tokens.redeem(token, externalUserId)
      : tokens.redeemAnySubscriber(token);

    if (!externalUserId) {
      console.warn(
        JSON.stringify({
          at: new Date().toISOString(),
          message: 'Bridge redeemed without verifying the caller',
          from: callerFrom(body).from ?? null
        })
      );
    }
    if ('error' in redeemed) {
      // Logged with the reason because these are indistinguishable from the
      // device: a caller who hung up, a slow answer, and a replayed token all
      // look the same there.
      console.warn(
        JSON.stringify({
          at: new Date().toISOString(),
          message: 'Bridge token rejected',
          reason: redeemed.error,
          externalUserId
        })
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
          at: new Date().toISOString(),
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
   * Ends the caller's leg when the bridge disconnects.
   *
   * SignalWire posts `calling.call.connect` events here for the connect issued
   * by /swml/bridge. `disconnected` means the device's leg is gone — and the
   * caller's leg is not returned to its script and is not hung up, so without
   * this it stays up, connected to nothing, in silence.
   */
  router.post('/bridge/status', signedBySignalWire, async (req, res) => {
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
      console.warn(
        JSON.stringify({
          at: new Date().toISOString(),
          message: 'Bridge status callback carried no token',
          state
        })
      );
      return;
    }

    const paired = tokens.claimCallerEnd(token);
    if ('error' in paired) {
      if (paired.error !== 'already-ended') {
        console.warn(
          JSON.stringify({
            at: new Date().toISOString(),
            message:
              paired.error === 'unknown'
                ? 'Bridge status: unknown token'
                : 'Bridge status for a token that was never bridged; ignoring',
            state
          })
        );
      }
      return;
    }

    if (!callEnder) {
      console.warn(
        JSON.stringify({
          at: new Date().toISOString(),
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

  /**
   * The user declined a parked call.
   *
   *   POST /swml/decline  { bridgeToken }  ->  204 | 400 | 404 | 409 | 410 | 502 | 503
   *
   * Called by the app, not SignalWire: in the parked-caller flow no SDK call
   * exists to reject, so without this a decline reaches nobody and the caller
   * hears ringback for the whole park window, then a busy hangup. The bridge
   * token is the authority — it was pushed only to this user's devices, is
   * single-use and expires with the park — so this needs neither the API token
   * (which an app cannot hold) nor a SignalWire signature.
   */
  router.post('/decline', async (req, res) => {
    const body = (req.body ?? {}) as { bridgeToken?: unknown };
    const token = body.bridgeToken;
    if (typeof token !== 'string' || token.length === 0) {
      res.status(400).json({ error: 'bridgeToken is required' });
      return;
    }
    if (!callEnder) {
      // Checked before the token is touched, so the call stays answerable.
      res.status(503).json({
        error:
          'No call ender configured (SIGNALWIRE_SPACE, SIGNALWIRE_PROJECT_ID, SIGNALWIRE_API_TOKEN); the caller cannot be ended'
      });
      return;
    }

    const declined = tokens.decline(token);
    if ('error' in declined) {
      const status = { unknown: 404, expired: 410, 'already-redeemed': 409, 'already-declined': 409 }[
        declined.error
      ];
      res.status(status).json({ error: declined.error });
      return;
    }

    const result = await callEnder.end(declined.callSid, 'decline');
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        message: result.ok ? 'Declined; ended caller leg' : 'Declined; failed to end caller leg',
        callSid: declined.callSid,
        ...(result.ok ? {} : { error: result.error })
      })
    );
    if (result.ok) {
      res.status(204).end();
    } else {
      res.status(502).json({ error: result.error });
    }
  });

  return router;
}
