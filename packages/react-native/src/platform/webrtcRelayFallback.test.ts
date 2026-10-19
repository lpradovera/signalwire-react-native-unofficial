/**
 * The SDK's relay-only ICE fallback against a peer connection shaped like
 * react-native-webrtc's.
 *
 * `ICEGatheringController.restartICEGatheringWithRelayOnly()` runs
 * `setConfiguration({ ...pc.getConfiguration(), iceTransportPolicy: 'relay' })`
 * and then `restartIce()`. react-native-webrtc 124.x has no `getConfiguration`,
 * so on a device the call threw a TypeError from a timer callback (fatal in a
 * release build) and the relay restart never ran.
 *
 * `ICEGatheringController` is internal to `@signalwire/js`, so this loads the
 * shipped CJS bundle unchanged, with one appended line that exports the class.
 * Node's own loader runs it, outside Jest's module registry, so its `rxjs`
 * is the real package.
 */
import { withGetConfiguration } from './webrtc';

interface Internals {
  ICEGatheringController: new (
    pc: unknown,
    negotiating$: unknown,
    options?: Record<string, unknown>
  ) => { handleICECandidateTimeout(): void; relayOnly: boolean; destroy(): void };
  BehaviorSubject: new (value: boolean) => unknown;
}

function loadSdkInternals(): Internals {
  // This package has no Node typings (its code runs in Hermes), so type what is used.
  const { readFileSync } = require('fs') as { readFileSync(path: string, enc: string): string };
  const { dirname } = require('path') as { dirname(path: string): string };
  // Resolved through jest.config.js's moduleNameMapper: the SDK's dist/index.cjs.
  const dist = (require as unknown as { resolve(id: string): string }).resolve('@signalwire/js');
  const source = readFileSync(dist, 'utf8');
  if (!/^var ICEGatheringController = class/m.test(source)) {
    throw new Error(`ICEGatheringController not found in ${dist}; update this test`);
  }
  type NodeModule = {
    filename: string;
    paths: string[];
    exports: Internals;
    require(id: string): { BehaviorSubject: Internals['BehaviorSubject'] };
    _compile(code: string, filename: string): void;
  };
  const Mod = require('module') as {
    new (id: string): NodeModule;
    _nodeModulePaths(dir: string): string[];
  };
  const mod = new Mod(dist);
  mod.filename = dist;
  mod.paths = Mod._nodeModulePaths(dirname(dist));
  mod._compile(
    `${source}\nmodule.exports.ICEGatheringController = ICEGatheringController;\n`,
    dist
  );
  return {
    ICEGatheringController: mod.exports.ICEGatheringController,
    BehaviorSubject: mod.require('rxjs').BehaviorSubject
  };
}

/** react-native-webrtc's surface for this path: no getConfiguration. */
class RNShapedPeerConnection extends EventTarget {
  calls: Array<[string, RTCConfiguration?]> = [];
  iceGatheringState = 'gathering';
  localDescription = null; // no valid SDP yet, so the timeout falls back to relay
  setConfiguration(configuration: RTCConfiguration): void {
    this.calls.push(['setConfiguration', configuration]);
  }
  restartIce(): void {
    this.calls.push(['restartIce']);
  }
}

describe("the SDK's relay-only ICE fallback on react-native-webrtc", () => {
  const { ICEGatheringController, BehaviorSubject } = loadSdkInternals();
  const iceServers = [{ urls: ['turn:turn.example:3478'], username: 'u', credential: 'p' }];

  function runFallback(PC: new (c?: RTCConfiguration) => RNShapedPeerConnection): {
    pc: RNShapedPeerConnection;
    run: () => void;
    controller: InstanceType<Internals['ICEGatheringController']>;
  } {
    const pc = new PC({ iceServers });
    const controller = new ICEGatheringController(pc, new BehaviorSubject(false));
    return { pc, controller, run: () => controller.handleICECandidateTimeout() };
  }

  it('throws without the shim (the reported crash)', () => {
    const { pc, run, controller } = runFallback(RNShapedPeerConnection);
    try {
      // A TypeError from Node's realm, not Jest's, so match the message.
      expect(run).toThrow(/getConfiguration is not a function/);
      expect(pc.calls).toEqual([]);
    } finally {
      controller.destroy();
    }
  });

  it('switches to relay and restarts ICE with the shim, keeping the ICE servers', () => {
    const Patched = withGetConfiguration(RNShapedPeerConnection);
    const { pc, run, controller } = runFallback(Patched);
    try {
      expect(run).not.toThrow();
      expect(controller.relayOnly).toBe(true);
      expect(pc.calls).toEqual([
        [
          'setConfiguration',
          {
            bundlePolicy: 'balanced',
            iceCandidatePoolSize: 0,
            iceServers,
            iceTransportPolicy: 'relay',
            rtcpMuxPolicy: 'require'
          }
        ],
        ['restartIce']
      ]);
      expect((pc as unknown as { getConfiguration(): RTCConfiguration }).getConfiguration())
        .toMatchObject({ iceTransportPolicy: 'relay', iceServers });
    } finally {
      controller.destroy();
    }
  });
});

/*
 * The same fallback against the installed react-native-webrtc's real
 * RTCPeerConnection class (the jest mock stands in for the package entry, so
 * this loads the class file directly), with its native module stubbed. It
 * catches a react-native-webrtc upgrade that adds its own getConfiguration,
 * or changes how setConfiguration and restartIce reach native code.
 */
describe("the SDK's relay-only ICE fallback on react-native-webrtc's real RTCPeerConnection", () => {
  const { NativeModules } = require('react-native') as {
    NativeModules: Record<string, unknown>;
  };
  const native = {
    peerConnectionInit: jest.fn(() => true),
    peerConnectionSetConfiguration: jest.fn(),
    peerConnectionRestartIce: jest.fn(),
    peerConnectionClose: jest.fn(),
    peerConnectionDispose: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn()
  };
  let previous: unknown;

  beforeAll(() => {
    previous = NativeModules.WebRTCModule;
    NativeModules.WebRTCModule = native;
  });

  afterAll(() => {
    NativeModules.WebRTCModule = previous;
  });

  it('has no getConfiguration of its own, and switches to relay with the shim', () => {
    const RealPC = require('react-native-webrtc/lib/commonjs/RTCPeerConnection').default as new (
      configuration?: RTCConfiguration
    ) => {
      iceGatheringState: string;
      setConfiguration(configuration: RTCConfiguration): void;
    };
    expect(typeof (RealPC.prototype as { getConfiguration?: unknown }).getConfiguration).toBe(
      'undefined'
    );

    const Patched = withGetConfiguration(RealPC);
    const iceServers = [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'p' }];
    const pc = new Patched({ iceServers });
    pc.iceGatheringState = 'gathering';
    const { ICEGatheringController, BehaviorSubject } = loadSdkInternals();
    const controller = new ICEGatheringController(pc, new BehaviorSubject(false));
    try {
      expect(() => controller.handleICECandidateTimeout()).not.toThrow();
      expect(controller.relayOnly).toBe(true);
      expect(native.peerConnectionSetConfiguration).toHaveBeenCalledTimes(1);
      const [configuration, id] = native.peerConnectionSetConfiguration.mock
        .calls[0] as unknown as [RTCConfiguration, number];
      expect(configuration).toMatchObject({
        iceTransportPolicy: 'relay',
        iceServers: [{ urls: ['turn:turn.example:3478'], username: 'u', credential: 'p' }]
      });
      expect(native.peerConnectionRestartIce).toHaveBeenCalledWith(id);
    } finally {
      controller.destroy();
    }
  });
});
