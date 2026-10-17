import { logger, useCalls } from '@signalwire/react';
import { useEffect, useRef } from 'react';
import { NativeModules, Platform } from 'react-native';

/** The package's foreground service (android/…/CallForegroundServiceModule.java). */
interface CallServiceNative {
  start(): void;
  stop(): void;
}

const NAME = 'SignalWireCallService';

function callService(): CallServiceNative | null {
  const native = (NativeModules as Record<string, Partial<CallServiceNative> | undefined> | undefined)?.[NAME];
  return typeof native?.start === 'function' && typeof native.stop === 'function'
    ? (native as CallServiceNative)
    : null;
}

let warnedUnlinked = false;

/**
 * Runs a `microphone` foreground service while a call is in progress, for
 * calls that are not in Telecom (the provider's `callKit` off).
 *
 * From Android 14 an app in the background records silence unless a
 * foreground service of type `microphone` is running (react-native-webrtc
 * #1774 and #1780; react-native-incall-manager #204 and #208): the lock
 * screen, or Home during a call, mutes the user mid-sentence. A call in
 * callkeep's ConnectionService has its own (`phoneCall|microphone`); a plain
 * WebRTC call had none. Android only lets the app start one while it is in
 * the foreground, which is where calls are placed and answered; a start
 * Android refuses is logged by the service.
 *
 * Asked again on each status change while a call is in progress: the first
 * call's microphone prompt can still be up when it is placed, and Android
 * refuses the service until the grant. A ringing inbound call does not count:
 * it has not taken the microphone. Renders nothing.
 */
export function CallForegroundService(): null {
  const { calls } = useCalls();
  const running = useRef(false);
  const android = Platform.OS === 'android';

  useEffect(() => {
    if (!android) {
      return;
    }
    const native = callService();
    if (!native) {
      if (calls.length > 0 && !warnedUnlinked) {
        warnedUnlinked = true;
        logger.warn(
          `${NAME} is not linked: calls without callKit have no microphone foreground service, ` +
            'so Android 14+ silences the microphone in the background. Rebuild the app.'
        );
      }
      return;
    }
    if (calls.length > 0) {
      native.start();
      running.current = true;
    } else if (running.current) {
      native.stop();
      running.current = false;
    }
  }, [android, calls]);

  useEffect(
    () => () => {
      if (running.current) {
        callService()?.stop();
        running.current = false;
      }
    },
    []
  );

  return null;
}
