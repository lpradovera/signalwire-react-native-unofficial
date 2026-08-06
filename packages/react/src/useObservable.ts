import { useMemo, useRef, useSyncExternalStore } from 'react';

import type { Observable } from 'rxjs';

interface ObservableStore<T> {
  subscribe(onStoreChange: () => void): () => void;
  getSnapshot(): T;
}

interface Peeked<T> {
  emitted: boolean;
  value: T | undefined;
}

/**
 * Synchronously peeks the current value of a hot observable.
 *
 * A plain BehaviorSubject emits on subscribe, so this captures the real value
 * before React's first paint. The SDK, however, pipes its state observables
 * through `observeOn(asapScheduler)`, which defers even a BehaviorSubject's
 * replay to a microtask — so this reports "nothing emitted" for most SDK
 * observables, and the caller's synchronous getter carries the value instead.
 */
function peek<T>(observable$: Observable<T>): Peeked<T> {
  let value: T | undefined;
  let emitted = false;
  const subscription = observable$.subscribe((next) => {
    value = next;
    emitted = true;
  });
  subscription.unsubscribe();
  return { emitted, value };
}

/**
 * Subscribes to an RxJS observable and returns its latest value.
 *
 * Built on `useSyncExternalStore`, so it is tear-free under concurrent
 * rendering — unlike the `useState` + `useEffect` pattern, where two components
 * reading the same observable can render with different values in one pass.
 *
 * Pass the SDK's synchronous getter as `initialValue`, for example
 * `useObservable(call?.status$, call?.status ?? 'new')`. That getter is not
 * merely a first-paint fallback: it is the authoritative value until the
 * observable actually emits, for the reasons below.
 *
 * Two properties of the SDK's observables make the obvious implementation
 * wrong, and both are invisible to tests that pass a plain BehaviorSubject:
 *
 * 1. **Identity is unstable.** `get isConnected$()` returns
 *    `deferEmission(this._isConnected$.asObservable())` — a new object on every
 *    access. Any `useMemo` keyed on it is invalidated every render, so a
 *    snapshot stored inside that memo is rebuilt constantly. It therefore lives
 *    in a ref that outlives the memo.
 *
 * 2. **Emission is deferred.** `deferEmission` pipes through
 *    `observeOn(asapScheduler)`, so the replayed value arrives in a microtask
 *    rather than on subscribe. Until it does, `initialValue` is tracked live —
 *    seeding once from the first render would strand a value the SDK has
 *    already moved past.
 *
 * Getting this wrong is not subtle in effect: `isConnected` stayed `false` for
 * the entire lifetime of a fully connected client, leaving the example app on
 * its "Connecting…" screen with a healthy authenticated WebSocket underneath.
 */
export function useObservable<T>(observable$: Observable<T> | undefined, initialValue: T): T {
  // Survives store rebuilds, which happen on every render (see 1 above).
  // Seeded once: callers pass literals such as `useObservable(x$, [])`, and
  // re-adopting a fresh `[]` each render would make `getSnapshot` return a new
  // reference every time, which trips React's "getSnapshot should be cached"
  // infinite-loop guard. A deferred emission corrects the value a microtask
  // later anyway, now that it is no longer discarded on the next render.
  const snapshotRef = useRef<T>(initialValue);
  const hasEmittedRef = useRef(false);

  const store = useMemo<ObservableStore<T>>(() => {
    if (observable$) {
      const peeked = peek(observable$);
      if (peeked.emitted) {
        snapshotRef.current = peeked.value as T;
        hasEmittedRef.current = true;
      }
    }

    return {
      subscribe(onStoreChange: () => void): () => void {
        if (!observable$) {
          return () => undefined;
        }
        const subscription = observable$.subscribe((next) => {
          if (hasEmittedRef.current && Object.is(next, snapshotRef.current)) {
            return;
          }
          snapshotRef.current = next;
          hasEmittedRef.current = true;
          onStoreChange();
        });
        return () => subscription.unsubscribe();
      },
      getSnapshot: (): T => snapshotRef.current
    };
  }, [observable$]);

  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
