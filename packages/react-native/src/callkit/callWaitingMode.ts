import { peekProcessGlobal } from '../platform/processGlobal';
import { CALLKIT_BRIDGE_KEY } from './bridgeKey';

/**
 * What happens when a call comes in, or the app dials, while a call is live.
 * The same on iOS and Android. Set with `getCallKit().setup({ callWaiting })`.
 *
 * - `'full'` (default): call waiting. The second call rings, and the user
 *   answers it with Hold & Accept (the live call goes on hold) or End &
 *   Accept, or declines it. Two calls can then be swapped, and either ended.
 *   Dialling during a call puts the live call on hold. At most two calls:
 *   a third incoming call is refused as busy, a third dial with
 *   `CallInProgressError`.
 * - `'endAndAccept'`: the second call rings, and answering it ends the live
 *   call. Dialling during a call throws `CallInProgressError`.
 * - `'single'`: one call at a time. A second incoming call is refused as busy
 *   (USER_BUSY) and never shown; dialling throws `CallInProgressError`.
 */
export type CallWaitingMode = 'full' | 'endAndAccept' | 'single';

/**
 * The call-waiting mode the native call UI was set up with, for UI that
 * offers Hold & Accept and End & Accept. `'full'` when there is no native
 * call UI: the app's own answer then holds the live call. Reads the bridge
 * without importing callkeep, like `useRingingPushes`.
 */
export function callWaitingMode(): CallWaitingMode {
  return peekProcessGlobal<{ callWaiting?: CallWaitingMode }>(CALLKIT_BRIDGE_KEY)?.callWaiting ?? 'full';
}
