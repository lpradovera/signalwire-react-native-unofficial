/** Runs one dial at a time. */
export interface DialGuard {
  /** True while a dial started through `run` has not settled. */
  readonly pending: boolean;
  /**
   * Starts `dial` unless one is already pending, in which case it resolves
   * `undefined` without dialling. A rejection reaches the caller.
   */
  run<T>(dial: () => Promise<T>): Promise<T | undefined>;
}

/**
 * Drops a start while a dial is pending.
 *
 * A dial takes hundreds of milliseconds (a directory lookup, getUserMedia, the
 * invite), and a second tap inside that window placed a second call: the
 * screen showed the later one, and the first stayed live with no control left
 * in the app to end it. React state alone cannot stop that, because two taps
 * can land before the re-render that disables the button; this flag is set
 * synchronously. `onPendingChange` lets the screen show it.
 */
export function createDialGuard(onPendingChange?: (pending: boolean) => void): DialGuard {
  let pending = false;
  const setPending = (next: boolean): void => {
    pending = next;
    onPendingChange?.(next);
  };
  return {
    get pending() {
      return pending;
    },
    async run<T>(dial: () => Promise<T>): Promise<T | undefined> {
      if (pending) {
        return undefined;
      }
      setPending(true);
      try {
        return await dial();
      } finally {
        setPending(false);
      }
    }
  };
}
