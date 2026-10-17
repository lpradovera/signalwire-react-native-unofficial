import { getCallHoldState } from './callHold';
import { logger } from './logger';

import type { CallObserver } from './types';
import type { Call, SignalWire } from '@signalwire/js';

/**
 * Statuses after which a call is over, or ending: it is neither active nor
 * held. `'ended'` is not in the SDK's type, but it is what the wire reports.
 * `'disconnected'` is not here: it is an ICE blip the SDK recovers from.
 */
const OVER: ReadonlySet<string> = new Set(['disconnecting', 'ended', 'failed', 'destroyed']);

function statusOf(call: Call): string | undefined {
  try {
    return call.status;
  } catch {
    // A destroyed call's getters can throw.
    return 'destroyed';
  }
}

/**
 * Whether `call` is in progress: placed by this device and not over, or
 * inbound and answered. An inbound call still ringing is not: it is waiting.
 */
export function isLiveCall(call: Call): boolean {
  const status = statusOf(call);
  if (status === undefined || OVER.has(status)) {
    return false;
  }
  return !(call.direction === 'inbound' && (status === 'ringing' || status === 'new'));
}

/** The client's calls in progress, oldest first. */
export function liveCallsOf(client: SignalWire | null | undefined): Call[] {
  let calls: Call[] = [];
  try {
    calls = client?.session?.calls ?? [];
  } catch {
    calls = [];
  }
  return calls.filter(isLiveCall);
}

/**
 * Applies a hold and tells the observer (the native call UI), in that
 * order: the observer only mirrors a state that took.
 */
export async function setCallHeld(
  call: Call,
  held: boolean,
  observer: CallObserver | undefined
): Promise<void> {
  const state = getCallHoldState();
  const was = state.isHeld(call);
  await state.setHeld(call, held);
  if (was !== held) {
    try {
      observer?.onHoldChange?.(call, held);
    } catch (error) {
      logger.warn('The call observer threw on a hold change:', error);
    }
  }
}

/**
 * Puts every call in progress other than `except` on hold, so the call about
 * to be placed or answered is the only one with live media. Returns the calls
 * it held, for {@link resumeCalls} if that call never happens.
 */
export async function holdOtherCalls(
  client: SignalWire | null | undefined,
  observer: CallObserver | undefined,
  except?: Call
): Promise<Call[]> {
  const state = getCallHoldState();
  const active = liveCallsOf(client).filter((call) => call !== except && !state.isHeld(call));
  const held: Call[] = [];
  for (const call of active) {
    await setCallHeld(call, true, observer);
    held.push(call);
  }
  return held;
}

/** Takes calls held by {@link holdOtherCalls} back off hold, best-effort. */
export async function resumeCalls(calls: Call[], observer: CallObserver | undefined): Promise<void> {
  for (const call of calls) {
    if (!isLiveCall(call)) {
      continue;
    }
    try {
      await setCallHeld(call, false, observer);
    } catch (error) {
      logger.warn(`Could not resume call ${call.id}:`, error);
    }
  }
}
