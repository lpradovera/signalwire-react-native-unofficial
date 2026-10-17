/**
 * What the platform layer and `@signalwire/js` rely on in the react-native-webrtc
 * that is actually installed, read from the package's own TypeScript source.
 *
 * Jest maps `react-native-webrtc` to a mock (jest/mocks), so the other tests
 * never see the real class. This one does, so a react-native-webrtc upgrade
 * that adds, renames or drops one of these methods fails here instead of on a
 * device.
 */

// This package has no Node typings (its code runs in Hermes), so type what is used.
const { readFileSync } = require('fs') as { readFileSync(path: string, enc: string): string };
const { dirname, join } = require('path') as {
  dirname(path: string): string;
  join(...parts: string[]): string;
};

const packageDir = dirname(
  (require as unknown as { resolve(id: string): string }).resolve('react-native-webrtc/package.json')
);

/** The method names a class in the package's `src/<file>.ts` declares. */
function methodsOf(file: string, className: string): Set<string> {
  const source = readFileSync(join(packageDir, 'src', file), 'utf8');
  const start = source.indexOf(`export default class ${className}`);
  if (start < 0) {
    throw new Error(`class ${className} not found in src/${file}; update this test`);
  }
  const names = new Set<string>();
  // Class members sit at four spaces: `    name(` or `    async name(`.
  for (const [, name] of source.slice(start).matchAll(/^ {4}(?:async |static |get |set )*(\w+)\s*\(/gm)) {
    if (name) {
      names.add(name);
    }
  }
  return names;
}

describe('the installed react-native-webrtc', () => {
  const version = (JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    version: string;
  }).version;

  it('satisfies the peer range floor (>=124.0.0)', () => {
    expect(Number(version.split('.')[0])).toBeGreaterThanOrEqual(124);
  });

  describe('RTCPeerConnection', () => {
    const methods = methodsOf('RTCPeerConnection.ts', 'RTCPeerConnection');

    it("has what the SDK's relay-only ICE fallback calls after getConfiguration", () => {
      // ICEGatheringController: setConfiguration({ ...getConfiguration(), relay }) then restartIce().
      expect(methods).toContain('setConfiguration');
      expect(methods).toContain('restartIce');
    });

    it('has getStats, which the SDK reads for inbound-rtp packets and the candidate pair', () => {
      expect(methods).toContain('getStats');
    });

    it(`still has no getConfiguration (so the SDK's relay fallback needs one supplied)`, () => {
      expect(methods).not.toContain('getConfiguration');
      expect(methods).toContain('constructor');
    });
  });

  it('has no RTCRtpSender.setStreams (the platform layer supplies it)', () => {
    const methods = methodsOf('RTCRtpSender.ts', 'RTCRtpSender');
    expect(methods).toContain('replaceTrack');
    expect(methods).not.toContain('setStreams');
  });
});
