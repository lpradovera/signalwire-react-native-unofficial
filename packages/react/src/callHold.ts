import { BehaviorSubject } from 'rxjs';

import { logger } from './logger';

import type { Call } from '@signalwire/js';
import type { Observable } from 'rxjs';

/**
 * The hold state of every call in the process, and the one way to change it.
 *
 * @signalwire/js 4.0.0-rc.5 has `call.toggleHold()` only: it sends
 * `verto.modify` hold or unhold depending on a private flag, and flips that
 * flag once the request resolves. Nothing public says whether a call is held,
 * and a toggle sent while another is in flight, or after a hold made
 * elsewhere (the native call UI, the app), applies the opposite of what was
 * asked. So every hold, in-app or native, goes through {@link setHeld}, which
 * compares the state first and runs the requests for one call one after
 * another.
 *
 * Process-wide (`globalThis`), not module-scoped: `@signalwire/react-native`
 * ships subpath bundles that would each get their own copy of a module-level
 * instance, and the native call UI and the app's hooks must see one state.
 */
export class CallHoldState {
  private readonly _held$ = new BehaviorSubject<ReadonlySet<Call>>(new Set());
  private readonly queues = new Map<Call, Promise<void>>();
  /** The state applied here, for a call whose SDK hides its own. */
  private readonly applied = new WeakMap<Call, boolean>();

  /** The calls on hold, re-emitted on every change. */
  get held$(): Observable<ReadonlySet<Call>> {
    return this._held$.asObservable();
  }

  get held(): ReadonlySet<Call> {
    return this._held$.value;
  }

  /**
   * Whether `call` is on hold. Reads the SDK's own flag when it has one (an
   * app calling `toggleHold()` directly changes that, not this class), else
   * what was last applied here.
   */
  isHeld(call: Call): boolean {
    const own = (call as unknown as { _holdState?: unknown })._holdState;
    if (typeof own === 'boolean') {
      return own;
    }
    return this.applied.get(call) ?? false;
  }

  /**
   * Puts `call` on hold or takes it off, after any request for it still in
   * flight. Does nothing when it is already in that state. Rejects with the
   * SDK's error when the request fails, and the state stays as it was.
   */
  setHeld(call: Call, held: boolean): Promise<void> {
    const previous = this.queues.get(call) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.isHeld(call) === held) {
          this.publish(call, held);
          return;
        }
        await call.toggleHold();
        this.applied.set(call, held);
        this.publish(call, held);
        logger.debug(`Call ${call.id} ${held ? 'held' : 'resumed'}`);
      });
    this.queues.set(call, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.queues.get(call) === next) {
          this.queues.delete(call);
        }
      });
    return next;
  }

  /** Forgets a call that has ended. */
  forget(call: Call): void {
    this.queues.delete(call);
    if (this._held$.value.has(call)) {
      const next = new Set(this._held$.value);
      next.delete(call);
      this._held$.next(next);
    }
  }

  private publish(call: Call, held: boolean): void {
    if (this._held$.value.has(call) === held) {
      return;
    }
    const next = new Set(this._held$.value);
    if (held) {
      next.add(call);
    } else {
      next.delete(call);
    }
    this._held$.next(next);
  }
}

const HOLD_KEY = '__signalwireReactCallHoldState';

/** The process-wide {@link CallHoldState}. */
export function getCallHoldState(): CallHoldState {
  const scope = globalThis as unknown as Record<string, CallHoldState | undefined>;
  let state = scope[HOLD_KEY];
  if (!state) {
    state = new CallHoldState();
    scope[HOLD_KEY] = state;
  }
  return state;
}

/** Test seam: drops the process-wide state. */
export function resetCallHoldStateForTesting(): void {
  delete (globalThis as unknown as Record<string, unknown>)[HOLD_KEY];
}
