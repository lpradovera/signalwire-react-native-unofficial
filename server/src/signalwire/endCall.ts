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
  end(callId: string, reason?: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface CallEnderOptions {
  space: string;
  projectId: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
}

export function createCallEnder({
  space,
  projectId,
  apiToken,
  fetchImpl = fetch
}: CallEnderOptions): CallEnder {
  const url = `https://${space}/api/calling/calls`;
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
          // form; the bare "end" is also rejected.
          body: JSON.stringify({ command: 'calling.end', id: callId, reason })
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          return { ok: false, error: `${response.status} ${text.slice(0, 160)}` };
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
