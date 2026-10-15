import { useEffect, useState } from 'react';

import { logger } from '@signalwire/react';
import { addAudioDeviceChangeListener, getAudioDeviceStatus } from './nativeAudioRoutes';

import type { AudioDeviceStatus } from './nativeAudioRoutes';

const NONE: AudioDeviceStatus = { available: [], selected: null, selectedName: '' };

/**
 * What the phone can play a call through and what it is playing through now,
 * kept current as headsets and cars connect and drop. Unlike `useAudioRoute`,
 * which reports the route that was asked for, this is what iOS settled on.
 *
 * iOS only: on Android it stays empty (`available: []`, `selected: null`).
 */
export function useAudioDevices(): AudioDeviceStatus {
  const [status, setStatus] = useState<AudioDeviceStatus>(NONE);

  useEffect(() => {
    let live = true;
    const unsubscribe = addAudioDeviceChangeListener((next) => {
      if (live) {
        setStatus(next);
      }
    });
    getAudioDeviceStatus()
      .then((current) => {
        if (live && current) {
          setStatus(current);
        }
      })
      .catch((error: unknown) => logger.warn('Failed to read the audio devices:', error));
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  return status;
}
