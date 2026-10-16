import { logger } from '@signalwire/react';
import { getCallKit } from './CallKeepBridge';

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
 *
 * @param getOptions - Read on every call, so the provider's latest props apply
 *   without rebuilding the observer.
 */
export function createCallKitObserver(
  getOptions: () => CallKitObserverOptions = () => ({})
): CallObserver {
  return {
    bindClient: (client) => getCallKit().bindClient(client),
    onOutgoingCall: (call, destination) =>
      void getCallKit().trackCall(call, destination, nameFor(destination, getOptions())),
    onIncomingAnswer: (call) => getCallKit().answerIncomingFromApp(call),
    onIncomingReject: (call) => getCallKit().rejectIncomingFromApp(call)
  };
}

/**
 * The app's name for a call, or the destination. Never throws: dial() has
 * already placed the call when this runs, and a throw would reject dial() and
 * keep the live call from the app, which could then never hang it up.
 */
function nameFor(destination: string, options: CallKitObserverOptions): string {
  try {
    // `||`, not `??`: an empty name would show as a blank caller in CallKit.
    return options.displayName?.(destination) || destination;
  } catch (error) {
    logger.warn(`callKit displayName threw for ${destination}; showing the destination:`, error);
    return destination;
  }
}
