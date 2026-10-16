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
/**
 * Walks an observable's `source` chain to the object it ultimately reads from.
 *
 * The SDK hands out `subject.asObservable().pipe(observeOn(asapScheduler))`,
 * building a new wrapper on every property access. Each wrapper keeps a
 * `source` reference, so following that chain reaches the underlying subject —
 * whose identity is stable for the life of the client or call.
 *
 * That gives a dependency that changes when the *source* genuinely changes
 * (a new call, a rebuilt client) but not merely because the getter was read
 * again, which is the difference between re-subscribing when it matters and
 * re-subscribing on every render.
 */
function rootSource(observable$: Observable<unknown> | undefined): unknown {
  let current: unknown = observable$;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  while (current && (current as any).source) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    current = (current as any).source;
  }
  return current;
}

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
 *    snapshot stored inside that memo is rebuilt constantly. The store is
 *    therefore keyed on the root subject behind it (see `rootSource`).
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
  // The caller's synchronous getter, read live until the source emits.
  const initialRef = useRef(initialValue);
  initialRef.current = initialValue;

  // The store takes the observable through a ref: it is keyed on the root
  // subject rather than on the observable itself (see below).
  const sourceRef = useRef(observable$);
  sourceRef.current = observable$;

  // Deliberately NOT keyed on `observable$`. Its identity changes on every
  // access — `get isConnected$()` returns a fresh `asObservable().pipe(...)` —
  // so keying on it hands React a new `subscribe` every render, and React
  // re-subscribes each time. For an observable that emits a fresh object per
  // emission (`addresses$` builds a new array; `participants$` likewise) the
  // `Object.is` guard below never matches, so every re-subscription reports a
  // change, which renders, which re-subscribes: an infinite loop that locks
  // the JS thread hard enough for Chrome to offer to kill the page.
  //
  // Keyed on the root subject instead: stable across repeated getter reads, but
  // genuinely different when the call or client behind it changes, so a real
  // swap still re-subscribes.
  const sourceKey = rootSource(observable$);

  const store = useMemo<ObservableStore<T>>(() => {
    // One store, and one value, per source. A different source (another call,
    // another client, or none) starts with nothing emitted: the old one's
    // value no longer applies (a healthy call B showed call A's error, whose
    // errors$ never emits, and call={null} kept the last call's status), so
    // until the new source emits, the caller's getter (initialValue) is the
    // value. The value lives in this closure, not in a ref the stores share:
    // React moves the subscription to the new store in a passive effect after
    // the commit, and until then the old source's subscription is live. With
    // End & Accept call A emitted its teardown in that window, and a shared
    // snapshot handed 'destroyed' to call B's screen.
    const source = sourceRef.current;
    let emitted = false;
    let snapshot: T | undefined;
    if (source) {
      const peeked = peek(source);
      if (peeked.emitted) {
        snapshot = peeked.value;
        emitted = true;
      }
    }

    return {
      subscribe(onStoreChange: () => void): () => void {
        if (!source) {
          return () => undefined;
        }
        const subscription = source.subscribe((next) => {
          if (emitted && Object.is(next, snapshot)) {
            return;
          }
          snapshot = next;
          emitted = true;
          onStoreChange();
        });
        return () => subscription.unsubscribe();
      },
      getSnapshot: (): T => (emitted ? (snapshot as T) : initialRef.current)
    };
    // `sourceKey` is not read inside the callback — it exists purely to force a
    // re-subscription when the underlying subject changes. That is exactly the
    // "cache key that isn't a syntactic dependency" case the rule cannot see.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
