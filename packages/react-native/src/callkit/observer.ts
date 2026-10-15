import { getCallKit } from './CallKeepBridge';
import { dialsVideo } from './dialMedia';

import type { SignalWire } from '@signalwire/js';
import type { CallObserver } from '@signalwire/react';

export interface CallKitObserverOptions {
  /**
   * The name the native call UI and Recents show for an outbound call. Default:
   * the destination itself, which for a Fabric address reads like
   * `/private/support-agent`.
   */
  displayName?: (destination: string) => string;
}

/**
 * A {@link CallObserver} backed by CallKit / ConnectionService.
 *
 * This is the whole of what the core needs to know about native call UI: the
 * core calls two optional methods, and everything else — the registry, the
 * bridge, callkeep itself — stays on this side of the boundary and never
 * reaches a browser bundle.
 */
export function createCallKitObserver(observerOptions: CallKitObserverOptions = {}): CallObserver {
  // Kept for its preferences, which decide (with the dial options) whether a
  // call carries video.
  let client: SignalWire | undefined;
  return {
    bindClient: (bound) => {
      client = bound;
      getCallKit().bindClient(bound);
    },
    onOutgoingCall: (call, destination, options) =>
      void getCallKit().trackCall(call, destination, observerOptions.displayName?.(destination) ?? destination, {
        video: dialsVideo(destination, options, client?.preferences)
      }),
    onIncomingAnswer: (call) => getCallKit().answerIncomingFromApp(call),
    onIncomingReject: (call) => getCallKit().rejectIncomingFromApp(call)
  };
}
