import { useCallback, useMemo } from 'react';
import { of } from 'rxjs';

import { logger, useObservable } from '@signalwire/react';
import { MissingPeerDependencyError } from '../errors';
import { getAudioRouteController } from './AudioRouteController';

import type { AudioRoute, AudioRouteController } from './AudioRouteController';

export interface UseAudioRouteResult {
  readonly route: AudioRoute;
  setRoute(route: AudioRoute): void;
  /** The speaker toggle: off returns to the call's earlier or default route. */
  setSpeakerOn(on: boolean): void;
}

const NO_ROUTING$ = of<AudioRoute>('earpiece');

/**
 * The controller, or `null` when incall-manager is installed but its native
 * module isn't linked (an app built before it was added): the controls that
 * call this hook must still render, as the CallKit bridge's calls still run.
 */
function controllerIfLinked(): AudioRouteController | null {
  try {
    return getAudioRouteController();
  } catch (error) {
    if (!(error instanceof MissingPeerDependencyError)) {
      throw error;
    }
    logger.warn('Audio routing unavailable:', error);
    return null;
  }
}

/**
 * Current audio output route and a setter. Without incall-manager's native
 * module (installed, app not rebuilt) it logs why once per mount, `route`
 * stays `'earpiece'` and the setters do nothing.
 */
export function useAudioRoute(): UseAudioRouteResult {
  const controller = useMemo(controllerIfLinked, []);
  const route = useObservable(controller?.route$ ?? NO_ROUTING$, controller?.route ?? 'earpiece');

  const setRoute = useCallback((next: AudioRoute): void => controller?.setRoute(next), [controller]);
  const setSpeakerOn = useCallback((on: boolean): void => controller?.setSpeakerOn(on), [controller]);

  return { route, setRoute, setSpeakerOn };
}
