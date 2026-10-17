/**
 * The bridge hands CallKit's audio-session activations to WebRTC on iOS:
 * react-native-webrtc's audioSessionDidActivate / audioSessionDidDeactivate
 * hooks, and WebRTC's manual audio (this package's SWWebRTCAudioSession), so
 * its audio unit restarts after every call change. Without it the phone sent
 * no audio after Hold & Accept, End & Accept, a second outbound call or a
 * resume (device retest on 15d093b, BUG-1).
 */
import InCallManager from 'react-native-incall-manager';
import RNCallKeep from '@signalwire/react-native-callkeep';
import { Subject } from 'rxjs';

import { resetAudioRouteControllerForTesting } from '../audio/AudioRouteController';
import { CallKeepBridge } from './CallKeepBridge';

/** Every native audio-session call, in order. */
const log: string[] = [];

const platform = { OS: 'ios' };
const nativeModules: Record<string, unknown> = {};

function linkNative(options: { sw?: boolean } = {}): void {
  for (const key of Object.keys(nativeModules)) {
    delete nativeModules[key];
  }
  Object.assign(nativeModules, {
    RNCallKeep: { setup: () => undefined },
    InCallManager: { start: () => undefined },
    WebRTCModule: {
      audioSessionDidActivate: jest.fn(() => log.push('webrtc.didActivate')),
      audioSessionDidDeactivate: jest.fn(() => log.push('webrtc.didDeactivate'))
    }
  });
  if (options.sw ?? true) {
    nativeModules.SWWebRTCAudioSession = {
      useManualAudio: jest.fn(() => {
        log.push('sw.useManualAudio');
        return true;
      }),
      setAudioEnabled: jest.fn((enabled: boolean) => {
        log.push(`sw.audio(${enabled ? 'on' : 'off'})`);
        return true;
      }),
      useAutomaticAudio: jest.fn(() => {
        log.push('sw.useAutomaticAudio');
        return true;
      })
    };
  }
}

jest.mock('react-native', () => ({
  get Platform() {
    return platform;
  },
  get NativeModules() {
    return nativeModules;
  }
}));

const callkeep = RNCallKeep as unknown as typeof RNCallKeep & {
  __emit: (event: string, payload: unknown) => void;
  __reset: () => void;
};

function createCall(id: string) {
  const { BehaviorSubject } = require('rxjs') as typeof import('rxjs');
  const status$ = new BehaviorSubject('ringing');
  return {
    id,
    from: '+15551234',
    fromName: 'Ada',
    status$,
    status: 'ringing',
    answer: jest.fn(),
    reject: jest.fn(),
    hangup: jest.fn(async () => undefined),
    toggleHold: jest.fn(async () => undefined),
    sendDigits: jest.fn(async () => undefined),
    self: { mute: jest.fn(), unmute: jest.fn() }
  };
}

const RESTART = ['webrtc.didActivate', 'sw.audio(off)', 'sw.audio(on)'];
const STOP = ['webrtc.didDeactivate', 'sw.audio(off)'];

describe('CallKeepBridge on iOS — WebRTC audio follows CallKit activations', () => {
  let bridge: CallKeepBridge;

  beforeEach(async () => {
    resetAudioRouteControllerForTesting();
    jest.clearAllMocks();
    jest.useFakeTimers();
    platform.OS = 'ios';
    linkNative();
    callkeep.__reset();
    log.length = 0;
    (InCallManager.start as jest.Mock).mockImplementation(() => log.push('incall.start'));
    bridge = new CallKeepBridge();
    await bridge.setup({ appName: 'Demo' });
  });

  afterEach(() => {
    bridge.destroy();
    jest.useRealTimers();
  });

  it('puts WebRTC on manual audio when the bridge is built, before any event', () => {
    expect(log).toEqual(['sw.useManualAudio']);
  });

  it('forwards an activation to react-native-webrtc, then restarts the audio unit', () => {
    log.length = 0;
    callkeep.__emit('didActivateAudioSession', {});
    expect(log).toEqual(RESTART);
  });

  it('forwards a deactivation, then stops the audio unit', () => {
    callkeep.__emit('didActivateAudioSession', {});
    log.length = 0;
    callkeep.__emit('didDeactivateAudioSession', {});
    expect(log).toEqual(STOP);
  });

  it('restarts the unit on Hold & Accept, where CallKit activates again with no deactivation', () => {
    // First call's activation, then the second call's: CW1 on iOS 27 sent
    // exactly this pair, and the unit CallKit had stopped stayed dead.
    callkeep.__emit('didActivateAudioSession', {});
    callkeep.__emit('didActivateAudioSession', {});
    expect(log.slice(1)).toEqual([...RESTART, ...RESTART]);
  });

  it('stops then restarts the unit across End & Accept, dial-again and swap (deactivate, activate)', () => {
    callkeep.__emit('didActivateAudioSession', {});
    log.length = 0;
    for (let i = 0; i < 3; i++) {
      callkeep.__emit('didDeactivateAudioSession', {});
      callkeep.__emit('didActivateAudioSession', {});
    }
    expect(log).toEqual([...STOP, ...RESTART, ...STOP, ...RESTART, ...STOP, ...RESTART]);
  });

  it('ignores a second deactivation, so react-native-webrtc counts each one once', () => {
    callkeep.__emit('didActivateAudioSession', {});
    log.length = 0;
    callkeep.__emit('didDeactivateAudioSession', {});
    callkeep.__emit('didDeactivateAudioSession', {});
    expect(log).toEqual(STOP);
  });

  it('restarts the unit before the waiting call starts its audio route', async () => {
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient({ session: { incomingCalls$: incoming$ } } as never);
    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    incoming$.next([createCall('c1')]);

    callkeep.__emit('answerCall', { callUUID: uuid });
    log.length = 0;
    callkeep.__emit('didActivateAudioSession', {});
    await jest.advanceTimersByTimeAsync(0);

    expect(log).toEqual([...RESTART, 'incall.start']);
  });

  it('forwards activations replayed from before JavaScript started, in order', () => {
    log.length = 0;
    callkeep.__emit('didLoadWithEvents', [
      { name: 'RNCallKeepDidActivateAudioSession', data: null },
      { name: 'RNCallKeepDidDeactivateAudioSession', data: null },
      { name: 'RNCallKeepDidActivateAudioSession', data: null }
    ]);
    expect(log).toEqual([...RESTART, ...STOP, ...RESTART]);
  });

  it('stops the unit when CallKit resets its provider with the session active', () => {
    callkeep.__emit('didActivateAudioSession', {});
    log.length = 0;
    callkeep.__emit('didResetProvider', {});
    expect(log).toEqual(STOP);
  });

  it('turns WebRTC audio on when the session never activates (the fallback timeout)', async () => {
    const incoming$ = new Subject<unknown[]>();
    bridge.bindClient({ session: { incomingCalls$: incoming$ } } as never);
    const uuid = bridge.reportIncomingPush({ callId: 'c1' });
    incoming$.next([createCall('c1')]);
    log.length = 0;

    callkeep.__emit('answerCall', { callUUID: uuid });
    await jest.advanceTimersByTimeAsync(3100);

    // WebRTC's unit first, then the route, as after an activation.
    expect(log).toEqual(['sw.audio(on)', 'incall.start']);
  });

  it('gives WebRTC its automatic audio back when destroyed', () => {
    log.length = 0;
    bridge.destroy();
    expect(log).toEqual(['sw.useAutomaticAudio']);
    bridge = new CallKeepBridge();
  });
});

describe('CallKeepBridge — WebRTC audio link edge cases', () => {
  afterEach(() => {
    platform.OS = 'ios';
    jest.useRealTimers();
  });

  it('only calls react-native-webrtc hooks when this package is not rebuilt in', async () => {
    resetAudioRouteControllerForTesting();
    linkNative({ sw: false });
    callkeep.__reset();
    log.length = 0;
    const bridge = new CallKeepBridge();
    await bridge.setup({ appName: 'Demo' });

    callkeep.__emit('didActivateAudioSession', {});
    callkeep.__emit('didDeactivateAudioSession', {});

    expect(log).toEqual(['webrtc.didActivate', 'webrtc.didDeactivate']);
    bridge.destroy();
  });

  it('does nothing on Android', async () => {
    resetAudioRouteControllerForTesting();
    platform.OS = 'android';
    linkNative();
    callkeep.__reset();
    log.length = 0;
    const bridge = new CallKeepBridge();

    callkeep.__emit('didActivateAudioSession', {});
    callkeep.__emit('didDeactivateAudioSession', {});

    expect(log).toEqual([]);
    bridge.destroy();
  });
});
