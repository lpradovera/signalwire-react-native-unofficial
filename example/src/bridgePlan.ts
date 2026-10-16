/** What answering a pushed call should do in the parked-caller topology. */
export type BridgePlan =
  | { action: 'dial'; destination: string }
  | { action: 'end'; reason: string }
  | { action: 'ignore'; reason: string };

/**
 * Decides how to act on an answered push entry.
 *
 * - With a bridge token and an address, dial the address with the token.
 * - With a bridge token and no address, the answer cannot be honoured: end the
 *   entry at once. The user has already accepted, and otherwise sits in an
 *   answered native call with nothing behind it until the answered timeout
 *   writes it off, while the caller hears ringback.
 * - Without a bridge token this is not a bridge push. An inbound SDK call may
 *   still arrive and fuse with the entry, so it is left alone.
 */
export function planBridgeAnswer(
  data: Record<string, string> | undefined,
  address: string | undefined
): BridgePlan {
  const token = data?.bridgeToken;
  if (!token) {
    return { action: 'ignore', reason: 'carries no bridge token' };
  }
  if (!address) {
    return {
      action: 'end',
      reason: 'EXPO_PUBLIC_SW_BRIDGE_ADDRESS is unset; cannot bridge, ending the call'
    };
  }
  return { action: 'dial', destination: `${address}?bridgeToken=${encodeURIComponent(token)}` };
}
