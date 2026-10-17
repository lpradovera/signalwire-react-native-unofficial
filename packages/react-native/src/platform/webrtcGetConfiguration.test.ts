import { RTCPeerConnection } from 'react-native-webrtc';

import { createWebRTCApiProvider, withGetConfiguration } from './webrtc';

/**
 * Shaped like react-native-webrtc 124.0.8's RTCPeerConnection: the constructor
 * sanitizes the configuration in place (lower-cases and arrays `urls`, drops
 * servers without urls, swaps certificates for `{ certificateId }`) and hands it
 * to native; `setConfiguration` and `restartIce` go straight to native. There
 * is no `getConfiguration`, and nothing keeps the configuration on the JS side.
 */
class RNShapedPeerConnection {
  static instances: RNShapedPeerConnection[] = [];
  calls: Array<[string, unknown?]> = [];

  constructor(configuration?: RTCConfiguration) {
    if (configuration) {
      const servers = (configuration.iceServers ?? []) as unknown as Array<Record<string, unknown>>;
      for (const server of servers) {
        let urls = (server.url ?? server.urls) as string | string[] | undefined;
        delete server.url;
        delete server.urls;
        if (!urls) {
          continue;
        }
        if (!Array.isArray(urls)) {
          urls = [urls];
        }
        server.urls = urls.map((url) => url.toLowerCase());
      }
      configuration.iceServers = servers.filter((s) => s.urls) as unknown as RTCIceServer[];
      if (configuration.certificates) {
        configuration.certificates = configuration.certificates.map(
          (cert) => ({ certificateId: (cert as unknown as { _id: string })._id }) as never
        );
      }
    }
    this.calls.push(['init', configuration]);
    RNShapedPeerConnection.instances.push(this);
  }

  setConfiguration(configuration: RTCConfiguration): void {
    this.calls.push(['setConfiguration', configuration]);
  }

  restartIce(): void {
    this.calls.push(['restartIce']);
  }
}

type WithConfig = RNShapedPeerConnection & { getConfiguration(): RTCConfiguration };
const Patched = withGetConfiguration(RNShapedPeerConnection) as unknown as new (
  configuration?: RTCConfiguration
) => WithConfig;

const DEFAULTS = {
  bundlePolicy: 'balanced',
  iceCandidatePoolSize: 0,
  iceServers: [],
  iceTransportPolicy: 'all',
  rtcpMuxPolicy: 'require'
};

describe('RTCPeerConnection.getConfiguration shim', () => {
  it('react-native-webrtc lacks getConfiguration, so the provider must supply it', () => {
    const provider = createWebRTCApiProvider();
    const pc = new provider.RTCPeerConnection({ iceServers: [{ urls: 'stun:a.example' }] });
    expect(typeof pc.getConfiguration).toBe('function');
    expect(pc.getConfiguration()).toEqual({
      ...DEFAULTS,
      // The jest mock does not sanitize urls; RNShapedPeerConnection below does.
      iceServers: [{ urls: 'stun:a.example' }]
    });
    expect(pc).toBeInstanceOf(RTCPeerConnection);
  });

  it('returns the standard defaults when constructed without a configuration', () => {
    expect(new Patched().getConfiguration()).toEqual(DEFAULTS);
  });

  it('returns the constructed configuration as react-native-webrtc sanitized it', () => {
    const cert = { _id: 'cert-1' } as unknown as RTCCertificate;
    const pc = new Patched({
      iceServers: [
        { urls: 'TURN:Turn.Example:3478', username: 'u', credential: 'p' },
        { urls: [] as unknown as string } // kept: an empty array is truthy, as in react-native-webrtc
      ],
      bundlePolicy: 'max-bundle',
      certificates: [cert]
    });
    expect(pc.getConfiguration()).toEqual({
      ...DEFAULTS,
      bundlePolicy: 'max-bundle',
      iceServers: [
        { urls: ['turn:turn.example:3478'], username: 'u', credential: 'p' },
        { urls: [] }
      ],
      // The caller's RTCCertificate objects, not react-native-webrtc's internal ids.
      certificates: [cert]
    });
  });

  it('keeps non-standard fields react-native-webrtc accepts, so a round trip does not drop them', () => {
    const pc = new Patched({ tcpCandidatePolicy: 'disabled' } as RTCConfiguration);
    expect(pc.getConfiguration()).toMatchObject({ tcpCandidatePolicy: 'disabled' });
  });

  it('tracks every setConfiguration call, with defaults for fields left out', () => {
    const pc = new Patched({ iceServers: [{ urls: 'stun:a.example' }], bundlePolicy: 'max-bundle' });
    pc.setConfiguration({ iceTransportPolicy: 'relay' });
    expect(pc.getConfiguration()).toEqual({ ...DEFAULTS, iceTransportPolicy: 'relay' });
    pc.setConfiguration({ iceServers: [{ urls: 'turn:b.example' }], iceCandidatePoolSize: 2 });
    expect(pc.getConfiguration()).toEqual({
      ...DEFAULTS,
      iceServers: [{ urls: 'turn:b.example' }],
      iceCandidatePoolSize: 2
    });
    // Still forwarded to native.
    expect(pc.calls.filter(([name]) => name === 'setConfiguration')).toHaveLength(2);
  });

  it('does not record a configuration native refused', () => {
    class Refusing extends RNShapedPeerConnection {
      setConfiguration(): void {
        throw new Error('refused');
      }
    }
    const PatchedRefusing = withGetConfiguration(Refusing) as unknown as new (
      configuration?: RTCConfiguration
    ) => WithConfig;
    const pc = new PatchedRefusing({ bundlePolicy: 'max-compat' });
    expect(() => pc.setConfiguration({ iceTransportPolicy: 'relay' })).toThrow('refused');
    expect(pc.getConfiguration()).toEqual({ ...DEFAULTS, bundlePolicy: 'max-compat' });
  });

  it('returns a copy each time, so a caller cannot change the recorded configuration', () => {
    const pc = new Patched({ iceServers: [{ urls: ['stun:a.example'] }] });
    const first = pc.getConfiguration();
    (first.iceServers?.[0]?.urls as string[]).push('stun:evil.example');
    first.iceServers?.push({ urls: 'stun:x.example' });
    first.iceTransportPolicy = 'relay';
    expect(pc.getConfiguration()).toEqual({ ...DEFAULTS, iceServers: [{ urls: ['stun:a.example'] }] });
    expect(pc.getConfiguration()).not.toBe(pc.getConfiguration());
  });

  it('is not affected by later changes to the object passed to setConfiguration', () => {
    const pc = new Patched();
    const config: RTCConfiguration = { iceServers: [{ urls: ['stun:a.example'] }] };
    pc.setConfiguration(config);
    (config.iceServers?.[0]?.urls as string[]).push('stun:later.example');
    config.bundlePolicy = 'max-compat';
    expect(pc.getConfiguration()).toEqual({ ...DEFAULTS, iceServers: [{ urls: ['stun:a.example'] }] });
  });

  it('leaves a class that already has getConfiguration alone', () => {
    class Standard extends RNShapedPeerConnection {
      getConfiguration(): RTCConfiguration {
        return {};
      }
    }
    expect(withGetConfiguration(Standard)).toBe(Standard);
  });

  it('wraps a class once, so every provider hands the SDK the same constructor', () => {
    expect(withGetConfiguration(RNShapedPeerConnection)).toBe(Patched);
    expect(createWebRTCApiProvider().RTCPeerConnection).toBe(
      createWebRTCApiProvider().RTCPeerConnection
    );
  });
});
