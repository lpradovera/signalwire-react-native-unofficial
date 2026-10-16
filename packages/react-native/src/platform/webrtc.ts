import {
  mediaDevices as rnMediaDevices,
  MediaStream as RNMediaStream,
  RTCPeerConnection as RNPeerConnection,
  RTCRtpSender as RNRtpSender
} from 'react-native-webrtc';

import { logger } from '@signalwire/react';
import { assertPeerModule } from './peers';

import type { WebRTCApiProvider, WebRTCMediaDevices } from '@signalwire/js';

/**
 * `RTCRtpSender.setStreams()` is a browser API that react-native-webrtc does
 * not implement. The SDK calls it on its inbound-answer path — reusing the
 * transceivers `setRemoteDescription` created from the offer — so answering
 * ANY inbound call on React Native threw "undefined is not a function" after
 * the user had already accepted on the native UI. Outbound calls never hit it:
 * they take the `addTransceiver` branch.
 *
 * A no-op is the honest shim. `setStreams` only re-associates the sender with
 * media streams for `a=msid` grouping in the SDP, and react-native-webrtc
 * offers no API to change that association after the fact. For single-stream
 * calls — every call this package makes — the association the answer already
 * carries is correct.
 *
 * Only installed when missing, so a react-native-webrtc release that implements
 * it wins automatically.
 */
function installSenderSetStreamsShim(): void {
  const proto = (RNRtpSender as unknown as { prototype?: Record<string, unknown> })?.prototype;
  if (proto && typeof proto.setStreams !== 'function') {
    proto.setStreams = function setStreams(): void {
      logger.debug('RTCRtpSender.setStreams is a no-op on React Native (shimmed)');
    };
  }
}

/**
 * The SDK constructs the bare global `MediaStream` on several paths: a dial
 * with `inputAudioStream`/`inputVideoStream`, a track added to a call that
 * started receive-only (unmute after a granted permission), a remote track
 * that arrives without a stream. React Native defines no `MediaStream`, and
 * react-native-webrtc installs its own only through `registerGlobals()`,
 * which also replaces `navigator.mediaDevices` and the RTC globals; this
 * package hands those to the SDK through the provider instead. So only the
 * one missing constructor is installed, and only when there is none.
 */
function installGlobalMediaStream(): void {
  const root = globalThis as { MediaStream?: unknown };
  if (typeof root.MediaStream === 'undefined') {
    root.MediaStream = RNMediaStream;
  }
}

/**
 * react-native-webrtc rejects getUserMedia with a `MediaStreamError`, which is
 * not an `Error`: a denied microphone or camera is
 * `{ name: 'SecurityError', message: 'Permission denied.' }`. The SDK's
 * MediaAccessError recognises a denial (`denied`, its 'denied' message,
 * `cause`) only on an `Error`, so the rejection is re-thrown as one with the
 * same name and message, and the original as its cause.
 */
function toError(reason: unknown): unknown {
  if (reason instanceof Error || typeof reason !== 'object' || reason === null) {
    return reason;
  }
  const { name, message, constraintName } = reason as {
    name?: unknown;
    message?: unknown;
    constraintName?: unknown;
  };
  const error = new Error(
    typeof message === 'string' ? message : String(name ?? 'getUserMedia failed')
  ) as Error & { cause?: unknown; constraintName?: unknown };
  error.cause = reason;
  if (typeof name === 'string') {
    error.name = name;
  }
  if (constraintName !== undefined) {
    error.constraintName = constraintName;
  }
  return error;
}

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

  installSenderSetStreamsShim();
  installGlobalMediaStream();

  const mediaDevices: WebRTCMediaDevices = {
    getUserMedia: (constraints) =>
      (rnMediaDevices.getUserMedia(constraints as never) as unknown as Promise<MediaStream>).catch(
        (reason: unknown) => {
          throw toError(reason);
        }
      ),
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
