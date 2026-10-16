import { AppState } from 'react-native';

import { logger } from '@signalwire/react';
import { installBaseGlobals } from './baseGlobals';
import { refCounted } from './refCounted';

type Listener = () => void;
type Visibility = 'visible' | 'hidden';

interface ShimDocument {
  visibilityState?: Visibility;
  addEventListener?: (type: string, listener: Listener) => void;
  removeEventListener?: (type: string, listener: Listener) => void;
}

const toVisibility = (appState: string): Visibility =>
  appState === 'active' ? 'visible' : 'hidden';

/**
 * Feeds RN's `AppState` into the globals the SDK's `VisibilityController`
 * probes: `document.visibilityState` and the `visibilitychange` event.
 *
 * `inactive` maps to `hidden` because on iOS that is the state during an
 * incoming call banner or a Control Centre pull-down, where media should be
 * treated as backgrounded.
 *
 * Additive — never replaces an existing `document`.
 */
function install(): () => void {
  installBaseGlobals();

  const root = globalThis as unknown as { document: ShimDocument };

  const listeners = new Map<string, Set<Listener>>();
  const previousAdd = root.document.addEventListener;
  const previousRemove = root.document.removeEventListener;

  root.document.addEventListener = (type: string, listener: Listener): void => {
    const set = listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(type, set);
    previousAdd?.call(root.document, type, listener);
  };

  root.document.removeEventListener = (type: string, listener: Listener): void => {
    listeners.get(type)?.delete(listener);
    previousRemove?.call(root.document, type, listener);
  };

  let current = toVisibility(AppState.currentState ?? 'active');
  root.document.visibilityState = current;

  const subscription = AppState.addEventListener('change', (next) => {
    const mapped = toVisibility(next);
    if (mapped === current) {
      return;
    }
    current = mapped;
    root.document.visibilityState = mapped;
    logger.debug(`Visibility shim: ${mapped}`);
    for (const listener of listeners.get('visibilitychange') ?? []) {
      try {
        listener();
      } catch (error) {
        logger.warn('Visibility shim listener threw:', error);
      }
    }
  });

  return (): void => {
    subscription.remove();
    listeners.clear();
    root.document.addEventListener = previousAdd;
    root.document.removeEventListener = previousRemove;
  };
}

/**
 * Installs the shim, or shares the install already in place. Returns this
 * caller's release; the shim is torn down when the last caller releases.
 */
export const installVisibilityShim: () => () => void = refCounted(install);
