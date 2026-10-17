import { logger } from '@signalwire/react';
import { getCallKit } from './CallKeepBridge';
import { displayableName } from './displayName';

import type { CallObserver } from '@signalwire/react';

export interface CallKitObserverOptions {
  /**
   * The name the native call UI and Recents show for an outbound call. Default:
   * a readable form of the destination: a Fabric address's last segment,
   * humanised (`/private/support-agent` shows as `Support Agent`), a SIP URI's
   * user part, or a number as it is. A Fabric address returned here is made
   * readable the same way; an empty name falls back to the default.
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
 *
 * @param getOptions - Read on every call, so the provider's latest props apply
 *   without rebuilding the observer.
 */
export function createCallKitObserver(
  getOptions: () => CallKitObserverOptions = () => ({})
): CallObserver {
  return {
    bindClient: (client) => getCallKit().bindClient(client),
    // Before the SDK places anything: no media, no invite, no second native call.
    beforeOutgoingCall: () => getCallKit().assertCanDial(),
    onOutgoingCall: (call, destination) =>
      void getCallKit().trackCall(call, destination, nameFor(destination, getOptions())),
    onIncomingAnswer: (call, others) => getCallKit().answerIncomingFromApp(call, others),
    onIncomingReject: (call) => getCallKit().rejectIncomingFromApp(call),
    onHoldChange: (call, held) => getCallKit().mirrorHold(call, held)
  };
}

/**
 * The app's name for a call, or a readable form of the destination, never a
 * raw Fabric address or a placeholder. Never throws: dial() has already placed
 * the call when this runs, and a throw would reject dial() and keep the live
 * call from the app, which could then never hang it up.
 */
function nameFor(destination: string, options: CallKitObserverOptions): string {
  let chosen: string | undefined;
  try {
    chosen = options.displayName?.(destination);
  } catch (error) {
    logger.warn(`callKit displayName threw for ${destination}; showing the destination:`, error);
  }
  // An empty name would show as a blank caller in CallKit: the destination's name instead.
  const context = `callKit displayName for ${destination}`;
  return displayableName(chosen, context) ?? displayableName(destination, context) ?? destination;
}
