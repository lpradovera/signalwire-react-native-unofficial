import { useSignalWire } from '@signalwire/react-native';
import { getCallKit } from '@signalwire/react-native/callkit';
import { useEffect, useRef } from 'react';

import { planBridgeAnswer } from './bridgePlan';
import { ConnectionGate } from './connectionGate';

import type { Call } from '@signalwire/js';

/** How long a cold-started app may take to come online before giving up. */
const BRIDGE_CONNECT_TIMEOUT_MS = 15000;

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

  // Read through refs and a gate so the effect subscribes once. Each answer
  // is handed to one subscriber, and `dial` changes identity when the
  // provider creates its client: an effect keyed on it re-subscribed on a
  // cold start, and the first copy, holding the `dial` of a client that did
  // not exist yet, failed and ended the call the user had answered. The gate
  // lets a waiting answer resume on the connection rather than on a poll.
  const dialRef = useRef(dial);
  dialRef.current = dial;
  const onCallStartedRef = useRef(onCallStarted);
  onCallStartedRef.current = onCallStarted;
  const gateRef = useRef<ConnectionGate | null>(null);
  if (!gateRef.current) {
    gateRef.current = new ConnectionGate();
  }
  const gate = gateRef.current;
  useEffect(() => {
    gate.set(isConnected);
  }, [gate, isConnected]);

  useEffect(() => {
    const bridge = getCallKit();

    const subscription = bridge.registry.answerRequested$.subscribe((entry) => {
      const plan = planBridgeAnswer(entry.data, process.env.EXPO_PUBLIC_SW_BRIDGE_ADDRESS);
      if (plan.action === 'ignore') {
        // Not a bridge push. If no SDK call fuses with it, the entry times
        // out as a missed call.
        console.warn(`Answered push ${entry.uuid} ${plan.reason}; ignoring`);
        return;
      }
      if (plan.action === 'end') {
        console.warn(plan.reason);
        bridge.registry.endCall(entry.uuid);
        return;
      }

      void (async () => {
        try {
          // Wait for the client to actually be connected before dialling.
          // On a cold start the push wakes the app and the answer can arrive
          // while the WebSocket is still being established; dialling then
          // fails, and the caller is left parked with nothing coming.
          if (!gate.isConnected) {
            console.log('Bridge answer waiting for the SDK connection');
          }
          if (!(await gate.wait(BRIDGE_CONNECT_TIMEOUT_MS))) {
            console.warn('SDK never connected; cannot bridge');
            bridge.registry.endCall(entry.uuid, 'failed');
            return;
          }
          // The user may have ended the call in CallKit while we waited.
          if (!bridge.registry.isLive(entry.uuid)) {
            console.log(`Entry ${entry.uuid} ended before the bridge dial; not dialling`);
            return;
          }

          // Claim the entry first: this dial joins a call the user has already
          // answered, so CallKit must adopt it rather than be told about a
          // second, outgoing call — it rejects that transaction outright.
          bridge.beginBridgeDial(entry.uuid);

          // Audio only: an SDP answer cannot introduce an m-line the offer
          // lacks, and this destination is a voice bridge.
          const call = await dialRef.current(plan.destination, {
            audio: true,
            video: false
          }).finally(() => bridge.endBridgeDial());

          // Bind before showing it: the entry may already be gone — the caller
          // hung up, or the user declined, while we were dialling — and a call
          // with no native entry behind it is a call the user cannot end.
          if (!bridge.bindBridgeCall(entry.uuid, call)) {
            console.warn(`Entry ${entry.uuid} vanished while dialling; hanging up`);
            // The bridge may already have hung it up (the user ended the call).
            void call.hangup().catch(() => undefined);
            return;
          }

          onCallStartedRef.current(call);
        } catch (error) {
          console.warn('Bridge dial failed:', (error as Error).message);
          // Ends the native entry so CallKit does not keep ringing for a call
          // that will never connect, as a failed call.
          bridge.registry.endCall(entry.uuid, 'failed');
        }
      })();
    });

    return () => subscription.unsubscribe();
  }, [gate]);
}
