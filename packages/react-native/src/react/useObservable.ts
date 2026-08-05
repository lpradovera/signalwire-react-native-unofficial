import { useMemo, useRef, useSyncExternalStore } from 'react';

import type { Observable } from 'rxjs';

interface ObservableStore<T> {
  subscribe(onStoreChange: () => void): () => void;
  getSnapshot(): T;
}

/**
 * Synchronously peeks the current value of a hot observable.
 *
 * SDK state observables are BehaviorSubjects, which emit on subscribe, so this
 * captures the real value before React's first paint. Anything that does not
 * emit synchronously leaves the fallback in place.
 */
function peek<T>(observable$: Observable<T>, fallback: T): T {
  let value = fallback;
  let emitted = false;
  const subscription = observable$.subscribe((next) => {
    value = next;
    emitted = true;
  });
  subscription.unsubscribe();
  return emitted ? value : fallback;
}

function createStore<T>(
  observable$: Observable<T> | undefined,
  initialValue: T
): ObservableStore<T> {
  let snapshot = observable$ ? peek(observable$, initialValue) : initialValue;

  return {
    subscribe(onStoreChange: () => void): () => void {
      if (!observable$) {
        return () => undefined;
      }
      const subscription = observable$.subscribe((next) => {
        if (Object.is(next, snapshot)) {
          return;
        }
        snapshot = next;
        onStoreChange();
      });
      return () => subscription.unsubscribe();
    },
    getSnapshot: (): T => snapshot
  };
}

/**
 * Subscribes to an RxJS observable and returns its latest value.
 *
 * Built on `useSyncExternalStore`, so it is tear-free under concurrent
 * rendering — unlike the `useState` + `useEffect` pattern, where two components
 * reading the same observable can render with different values in one pass.
 *
 * Pass the SDK's synchronous getter as `initialValue`, for example
 * `useObservable(call?.status$, call?.status ?? 'new')`.
 */
export function useObservable<T>(observable$: Observable<T> | undefined, initialValue: T): T {
  const initialRef = useRef(initialValue);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const store = useMemo(() => createStore(observable$, initialRef.current), [observable$]);

  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
