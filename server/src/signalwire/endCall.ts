import { spaceHost } from './subscriberTokens.js';

/**
 * Ends a call leg by id, through the Calling REST API.
 *
 * This exists because hanging up the device's leg does not end the caller's.
 * The caller is parked by our own SWML and then bridged into; when the device
 * leaves, that leg is not returned to its script and is not hung up — it sits
 * there, connected to nothing, silent, until something ends it. Nothing in the
 * SWML we control can reach it at that point, so the server does it here.
 *
 * Note the API: `/api/laml/.../Calls/<sid>` does not know these ids and
 * answers 404. Fabric call ids live under the Calling API, which dispatches
 * every command to one endpoint with a `command` field.
 */
export interface CallEnder {
  /**
   * `status` is SignalWire's HTTP status when it answered. 404 means it does
   * not know the id: see {@link UNENDABLE_LEG_HINT}.
   */
  end(
    callId: string,
    reason?: string
  ): Promise<{ ok: true } | { ok: false; error: string; status?: number }>;
}

/**
 * Why a parked caller's id can be unknown to the Calling API, and what to do.
 *
 * When the caller reaches the park handler's Fabric address through a REST
 * dial or another SWML script, SignalWire runs the park on an internal leg
 * (its `to` is `sip:steer@...`) and that leg's id is not one the API can
 * act on. Verified on 2026-10-17 against a live parked leg after its bridge
 * ended: `calling.end` (with or without `node_id`), the Calling API's
 * `update` with `status: completed`, and the compatibility (LaML) Calls
 * update with `Status=completed` all answered 404, while the top-level leg
 * stayed answered. A phone number pointed at the handler, or a dial whose
 * own SWML is the park URL, runs the park on the caller's top-level leg, and
 * ending it works.
 */
export const UNENDABLE_LEG_HINT =
  'SignalWire does not know this call id: the park SWML ran on an internal leg, which happens when the ' +
  'caller reached the park address through a REST dial or another SWML script to a Fabric address. No ' +
  'API call ends that leg (calling.end, update status=completed and the LaML Calls update all answer ' +
  '404); it ends with the caller\'s own script or max_duration. Real inbound calls (a phone number ' +
  'pointed at the park handler) park on the top-level leg and are ended. To test, dial the park handler ' +
  'from a phone number, or as a top-level call (the park URL as the dial\'s own SWML). See docs/push-setup.md.';

export interface CallEnderOptions {
  space: string;
  projectId: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  /** Bound on the REST request. Default 10s. */
  timeoutMs?: number;
}

export function createCallEnder({
  space,
  projectId,
  apiToken,
  fetchImpl = fetch,
  timeoutMs = 10_000
}: CallEnderOptions): CallEnder {
  const url = `https://${spaceHost(space)}/api/calling/calls`;
  const auth = Buffer.from(`${projectId}:${apiToken}`).toString('base64');

  return {
    async end(callId, reason = 'hangup') {
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            authorization: `Basic ${auth}`,
            'content-type': 'application/json'
          },
          // `id`, not `call_id`: the endpoint answers 404 for `call_id`, and a
          // 404 here reads as "no such call" rather than "wrong field name",
          // which is a slow thing to discover. `command` is the namespaced
          // form; the bare "end" is also rejected. `reason` goes under
          // `params`, as the Calling API's CallHangupRequest schema has it.
          body: JSON.stringify({ command: 'calling.end', id: callId, params: { reason } }),
          signal: AbortSignal.timeout(timeoutMs)
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          return {
            ok: false,
            error: `${response.status} ${text.slice(0, 160)}`,
            status: response.status
          };
        }
        return { ok: true };
      } catch (error) {
        // A failure here strands a caller, so it is reported rather than
        // thrown: the route logs it, and the device is already gone.
        return { ok: false, error: (error as Error).message };
      }
    }
  };
}

/** Builds an ender if the space credentials are present. */
export function createCallEnderFromEnv(
  env: NodeJS.ProcessEnv = process.env
): CallEnder | undefined {
  const { SIGNALWIRE_SPACE, SIGNALWIRE_PROJECT_ID, SIGNALWIRE_API_TOKEN } = env;
  if (!SIGNALWIRE_SPACE || !SIGNALWIRE_PROJECT_ID || !SIGNALWIRE_API_TOKEN) {
    return undefined;
  }
  return createCallEnder({
    space: SIGNALWIRE_SPACE,
    projectId: SIGNALWIRE_PROJECT_ID,
    apiToken: SIGNALWIRE_API_TOKEN
  });
}
