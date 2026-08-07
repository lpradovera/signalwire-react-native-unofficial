import { useSignalWire } from '@signalwire/react-native';
import { getCallKit } from '@signalwire/react-native/callkit';
import { useEffect, useRef } from 'react';

import type { Call } from '@signalwire/js';

/** How long a cold-started app may take to come online before giving up. */
const BRIDGE_CONNECT_TIMEOUT_MS = 15000;

/** Resolves when `ready` returns true, or after `timeoutMs`. */
async function waitFor(ready: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!ready() && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/**
 * Places the call that joins a parked caller, when the user answers a push.
 *
 * The inbound flow parks the caller on ringback rather than dialling this
 * device, because a device woken by push needs seconds to launch, authenticate
 * and come online — an invite arriving before that just fails, and cold start
 * is the case push exists for. So nothing is ringing here to answer: on accept,
 * *we* dial, and the server bridges us to the waiting caller.
 *
 * The push carries an opaque single-use token, never the caller's call SID: a
 * payload containing that is a capability anyone replaying it could spend. The
 * server resolves the token and serves the SWML that performs the connect.
 */
export function useBridgeAnswer(onCallStarted: (call: Call) => void): void {
  const { dial, isConnected } = useSignalWire();

  // Read through a ref so the effect does not re-subscribe when the
  // connection flips, which would drop a replayed answer on the floor.
  const connectedRef = useRef(isConnected);
  connectedRef.current = isConnected;

  useEffect(() => {
    const bridge = getCallKit();

    const subscription = bridge.registry.answerRequested$.subscribe((entry) => {
      const token = entry.data?.bridgeToken;
      if (!token) {
        // Nothing to bridge to. The entry times out as a missed call, which is
        // the right outcome — better than a native UI wired to nothing.
        console.warn(`Answered push ${entry.uuid} carries no bridge token; ignoring`);
        return;
      }

      const address = process.env.EXPO_PUBLIC_SW_BRIDGE_ADDRESS;
      if (!address) {
        console.warn('EXPO_PUBLIC_SW_BRIDGE_ADDRESS is unset; cannot bridge');
        return;
      }

      void (async () => {
        try {
          // Wait for the client to actually be connected before dialling.
          // On a cold start the push wakes the app and the answer can arrive
          // while the WebSocket is still being established; dialling then
          // fails, and the caller is left parked with nothing coming.
          if (!connectedRef.current) {
            console.log('Bridge answer waiting for the SDK connection');
            await waitFor(() => connectedRef.current, BRIDGE_CONNECT_TIMEOUT_MS);
          }
          if (!connectedRef.current) {
            console.warn('SDK never connected; cannot bridge');
            bridge.registry.endCall(entry.uuid);
            return;
          }

          // Claim the entry first: this dial joins a call the user has already
          // answered, so CallKit must adopt it rather than be told about a
          // second, outgoing call — it rejects that transaction outright.
          bridge.beginBridgeDial(entry.uuid);

          // Audio only: an SDP answer cannot introduce an m-line the offer
          // lacks, and this destination is a voice bridge.
          const call = await dial(`${address}?bridgeToken=${encodeURIComponent(token)}`, {
            audio: true,
            video: false
          }).finally(() => bridge.endBridgeDial());

          // Bind before showing it: the entry may already be gone — the caller
          // hung up, or the user declined, while we were dialling — and a call
          // with no native entry behind it is a call the user cannot end.
          if (!bridge.bindBridgeCall(entry.uuid, call)) {
            console.warn(`Entry ${entry.uuid} vanished while dialling; hanging up`);
            void call.hangup();
            return;
          }

          onCallStarted(call);
        } catch (error) {
          console.warn('Bridge dial failed:', (error as Error).message);
          // Ends the native entry so CallKit does not keep ringing for a call
          // that will never connect.
          bridge.registry.endCall(entry.uuid);
        }
      })();
    });

    return () => subscription.unsubscribe();
  }, [dial, onCallStarted]);
}
