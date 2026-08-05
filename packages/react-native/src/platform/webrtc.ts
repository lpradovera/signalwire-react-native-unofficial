import {
  mediaDevices as rnMediaDevices,
  RTCPeerConnection as RNPeerConnection
} from 'react-native-webrtc';

import { logger } from '../logger';
import { assertPeerModule } from './peers';

import type { WebRTCApiProvider, WebRTCMediaDevices } from '@signalwire/js';

let warnedAboutDeviceEvents = false;

function warnOnceAboutDeviceEvents(): void {
  if (warnedAboutDeviceEvents) {
    return;
  }
  warnedAboutDeviceEvents = true;
  logger.debug(
    'React Native emits no "devicechange" event. Device listeners are no-ops; ' +
      'call enumerateDevices() manually when you need a refreshed list.'
  );
}

/**
 * Builds the SDK's WebRTC provider from `react-native-webrtc`.
 *
 * `getDisplayMedia` is intentionally absent: the SDK probes for it to decide
 * whether screen share is supported, and React Native cannot provide it.
 */
export function createWebRTCApiProvider(): WebRTCApiProvider {
  assertPeerModule(
    rnMediaDevices as object | undefined,
    'react-native-webrtc',
    'WebRTC support',
    'getUserMedia'
  );

  const mediaDevices: WebRTCMediaDevices = {
    getUserMedia: (constraints) =>
      rnMediaDevices.getUserMedia(constraints as never) as unknown as Promise<MediaStream>,
    enumerateDevices: () =>
      rnMediaDevices.enumerateDevices() as unknown as Promise<MediaDeviceInfo[]>,
    addEventListener: () => warnOnceAboutDeviceEvents(),
    removeEventListener: () => warnOnceAboutDeviceEvents()
  };

  return {
    RTCPeerConnection: RNPeerConnection as unknown as typeof RTCPeerConnection,
    mediaDevices
  };
}
