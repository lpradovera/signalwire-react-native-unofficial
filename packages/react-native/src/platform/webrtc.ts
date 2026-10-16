import { logger } from '@signalwire/react';
import { loadReactNativeWebRTC } from './reactNativeWebRTC';

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
function installSenderSetStreamsShim(RNRtpSender: unknown): void {
  const proto = (RNRtpSender as unknown as { prototype?: Record<string, unknown> })?.prototype;
  if (proto && typeof proto.setStreams !== 'function') {
    proto.setStreams = function setStreams(): void {
      logger.debug('RTCRtpSender.setStreams is a no-op on React Native (shimmed)');
    };
  }
}

interface ConfigurablePeerConnection {
  setConfiguration(configuration: RTCConfiguration): void;
}

type PeerConnectionClass = new (configuration?: RTCConfiguration) => ConfigurablePeerConnection;

/** The recorded configuration of each shimmed connection. */
const configurations = new WeakMap<object, RTCConfiguration>();
/** One subclass per base class, so every provider hands the SDK the same constructor. */
const shimmedClasses = new WeakMap<object, PeerConnectionClass>();

function copyIceServer(server: RTCIceServer): RTCIceServer {
  return { ...server, urls: Array.isArray(server.urls) ? [...server.urls] : server.urls };
}

/**
 * The configuration as `getConfiguration()` reports it: every field the caller
 * passed (react-native-webrtc also reads non-standard ones), the standard
 * fields defaulted as in the WebRTC spec (which are also the native defaults
 * on iOS and Android), and fresh arrays, so no caller shares the stored copy.
 */
function snapshotConfiguration(
  configuration: RTCConfiguration | undefined,
  certificates = configuration?.certificates
): RTCConfiguration {
  const snapshot: RTCConfiguration = {
    ...configuration,
    bundlePolicy: configuration?.bundlePolicy ?? 'balanced',
    iceCandidatePoolSize: configuration?.iceCandidatePoolSize ?? 0,
    iceServers: (configuration?.iceServers ?? []).map(copyIceServer),
    iceTransportPolicy: configuration?.iceTransportPolicy ?? 'all',
    rtcpMuxPolicy: configuration?.rtcpMuxPolicy ?? 'require'
  };
  if (certificates) {
    snapshot.certificates = [...certificates];
  } else {
    delete snapshot.certificates;
  }
  return snapshot;
}

/**
 * Adds the standard `RTCPeerConnection.getConfiguration()`, which
 * react-native-webrtc (124.x) does not implement. The SDK's relay-only ICE
 * fallback (`ICEGatheringController.restartICEGatheringWithRelayOnly`) runs
 * `setConfiguration({ ...pc.getConfiguration(), iceTransportPolicy: 'relay' })`
 * and then `restartIce()`. Without `getConfiguration` it threw a TypeError
 * from a timer callback (fatal in a release build), and the relay restart
 * never ran.
 *
 * react-native-webrtc keeps no copy of the configuration on the JS side: the
 * constructor and `setConfiguration` hand it straight to native. So the
 * returned subclass records it: the constructed configuration as
 * react-native-webrtc sanitized it (`urls` lower-cased into arrays, servers
 * without urls dropped) with the caller's certificates, then the configuration
 * of every `setConfiguration` call native accepted. As in the spec,
 * `setConfiguration` replaces the whole configuration, and `getConfiguration()`
 * returns a copy.
 *
 * A class that already has `getConfiguration` is returned unchanged, so a
 * react-native-webrtc release that implements it wins automatically.
 */
export function withGetConfiguration<T extends PeerConnectionClass>(Base: T): T {
  const proto = Base.prototype as { getConfiguration?: unknown } | undefined;
  if (typeof proto?.getConfiguration === 'function') {
    return Base;
  }
  const existing = shimmedClasses.get(Base);
  if (existing) {
    return existing as T;
  }

  class PeerConnectionWithConfiguration extends (Base as PeerConnectionClass) {
    constructor(configuration?: RTCConfiguration) {
      // react-native-webrtc replaces these with internal ids, in place.
      const certificates = configuration?.certificates;
      super(configuration);
      configurations.set(this, snapshotConfiguration(configuration, certificates));
    }

    setConfiguration(configuration: RTCConfiguration): void {
      super.setConfiguration(configuration);
      configurations.set(this, snapshotConfiguration(configuration));
    }

    getConfiguration(): RTCConfiguration {
      return snapshotConfiguration(configurations.get(this));
    }
  }

  shimmedClasses.set(Base, PeerConnectionWithConfiguration);
  return PeerConnectionWithConfiguration as unknown as T;
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
  const {
    mediaDevices: rnMediaDevices,
    RTCPeerConnection: RNPeerConnection,
    RTCRtpSender: RNRtpSender
  } = loadReactNativeWebRTC('WebRTC support');

  installSenderSetStreamsShim(RNRtpSender);

  const mediaDevices: WebRTCMediaDevices = {
    getUserMedia: (constraints) =>
      rnMediaDevices.getUserMedia(constraints as never) as unknown as Promise<MediaStream>,
    enumerateDevices: () =>
      rnMediaDevices.enumerateDevices() as unknown as Promise<MediaDeviceInfo[]>,
    addEventListener: () => warnOnceAboutDeviceEvents(),
    removeEventListener: () => warnOnceAboutDeviceEvents()
  };

  return {
    RTCPeerConnection: withGetConfiguration(
      RNPeerConnection as unknown as PeerConnectionClass
    ) as unknown as typeof RTCPeerConnection,
    mediaDevices
  };
}
