import { useCallback, useMemo } from 'react';

import { useObservable } from '@signalwire/react';
import { getAudioRouteController } from './AudioRouteController';

import type { AudioRoute } from './AudioRouteController';

export interface UseAudioRouteResult {
  readonly route: AudioRoute;
  setRoute(route: AudioRoute): void;
  /** The speaker toggle: off returns to the call's earlier or default route. */
  setSpeakerOn(on: boolean): void;
}

/** Current audio output route and a setter. */
export function useAudioRoute(): UseAudioRouteResult {
  const controller = useMemo(() => getAudioRouteController(), []);
  const route = useObservable(controller.route$, controller.route);

  const setRoute = useCallback((next: AudioRoute): void => controller.setRoute(next), [controller]);
  const setSpeakerOn = useCallback((on: boolean): void => controller.setSpeakerOn(on), [controller]);

  return { route, setRoute, setSpeakerOn };
}
