import { Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';

import { logger } from '@signalwire/react';
import {
  deviceStatus,
  incallIosRoutes,
  installIncallIosRoutes,
  reportDevice,
  uninstallIncallIosRoutes
} from '../../jest/mocks/incallIosRoutes';
import { AudioRouteController, resetAudioRouteControllerForTesting } from './AudioRouteController';

const flag = InCallManager.setForceSpeakerphoneOn as jest.Mock;
const choose = InCallManager.chooseAudioRoute as jest.Mock;

/** Lets promise chains (the status read, a rejected choice) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

let controller: AudioRouteController;
let warn: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  resetAudioRouteControllerForTesting();
  warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  controller = new AudioRouteController();
});

afterEach(() => {
  controller.destroy();
  uninstallIncallIosRoutes();
  warn.mockRestore();
});

describe('AudioRouteController', () => {
  it('defaults to earpiece before a session starts', () => {
    expect(controller.route).toBe('earpiece');
  });

  it('start("audio") begins an audio session off the speaker', () => {
    controller.start('audio');
    expect(InCallManager.start).toHaveBeenCalledWith({ media: 'audio' });
    expect(controller.route).toBe('earpiece');
    expect(flag).toHaveBeenCalledWith(false);
    expect(choose).not.toHaveBeenCalled();
  });

  it('start("video") defaults to speaker', () => {
    controller.start('video');
    expect(InCallManager.start).toHaveBeenCalledWith({ media: 'video' });
    expect(controller.route).toBe('speaker');
    expect(flag).toHaveBeenCalledWith(true);
  });

  it('emits every route change on route$', () => {
    const seen: string[] = [];
    controller.route$.subscribe((route) => seen.push(route));
    controller.start('audio');
    controller.setSpeakerOn(true);
    controller.setSpeakerOn(true);
    controller.setSpeakerOn(false);
    expect(seen).toEqual(['earpiece', 'earpiece', 'speaker', 'earpiece']);
  });

  it('does not restart an already-started session or reset the route', () => {
    // An inbound call starts audio on the native answer and again when it
    // reaches `connected`. A second start would re-run InCallManager and force
    // the route back to its default, discarding the user's speaker toggle.
    controller.start('audio');
    controller.setSpeakerOn(true);
    (InCallManager.start as jest.Mock).mockClear();
    controller.start('audio');
    expect(InCallManager.start).not.toHaveBeenCalled();
    expect(controller.route).toBe('speaker');
  });

  it('stop ends the session and touches nothing native after it', () => {
    // incall-manager's setForceSpeakerphoneOn has no started guard: after a
    // video call it would switch the torn-down session to voice chat mode
    // and turn the proximity sensor back on.
    const order: string[] = [];
    (InCallManager.stop as jest.Mock).mockImplementation(() => order.push('stop'));
    flag.mockImplementation((on: boolean) => order.push(`flag:${String(on)}`));
    controller.start('video');
    order.length = 0;

    controller.stop();

    expect(order).toEqual(['stop']);
    expect(controller.route).toBe('earpiece');
  });

  it('stop without start does not throw, and calls nothing native', () => {
    expect(() => controller.stop()).not.toThrow();
    expect(InCallManager.stop).not.toHaveBeenCalled();
    expect(flag).not.toHaveBeenCalled();
  });

  it('survives InCallManager throwing', () => {
    (InCallManager.start as jest.Mock).mockImplementationOnce(() => {
      throw new Error('native module missing');
    });
    expect(() => controller.start('audio')).not.toThrow();
  });

  describe('the speaker toggle', () => {
    it('off returns to the default route, not a receiver choice', () => {
      controller.start('audio');
      controller.setSpeakerOn(true);
      controller.setSpeakerOn(false);
      expect(controller.route).toBe('earpiece');
      expect(flag).toHaveBeenLastCalledWith(false);
      expect(choose).not.toHaveBeenCalled();
    });

    it('off in a video call turns the speaker off (voice chat mode), not to the media default', () => {
      // The default (null) in a video call is video chat mode: the loudspeaker.
      controller.start('video');
      controller.setSpeakerOn(false);
      expect(controller.route).toBe('earpiece');
      expect(flag).toHaveBeenLastCalledWith(false);
    });

    it("forgets the last call's choice once the call ends", () => {
      controller.start('audio');
      controller.setRoute('speaker');
      controller.stop();
      controller.start('video');
      flag.mockClear();
      controller.setSpeakerOn(false);
      expect(controller.route).toBe('earpiece');
      expect(flag).toHaveBeenCalledWith(false);
    });

    it('on and off are no-ops when already there', () => {
      controller.start('audio');
      flag.mockClear();
      controller.setSpeakerOn(false);
      controller.setSpeakerOn(true);
      controller.setSpeakerOn(true);
      expect(flag).toHaveBeenCalledTimes(1);
    });
  });

  describe('on iOS without incall-manager iOS routes (released incall-manager)', () => {
    it('setRoute("earpiece") turns the speaker off, without a route it cannot choose', async () => {
      controller.start('audio');
      controller.setRoute('speaker');
      controller.setRoute('earpiece');
      await flush();
      expect(flag).toHaveBeenLastCalledWith(false);
      expect(choose).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it('ignores Bluetooth with one warning, leaving the route and the speaker alone', () => {
      controller.start('video');
      flag.mockClear();
      controller.setRoute('bluetooth');
      controller.setRoute('bluetooth');
      expect(controller.route).toBe('speaker');
      expect(flag).not.toHaveBeenCalled();
      expect(choose).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('warns once per process, not once per controller', () => {
      controller.setRoute('bluetooth');
      new AudioRouteController().setRoute('bluetooth');
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('logs nothing at call start', () => {
      controller.start('audio');
      controller.stop();
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('on Android', () => {
    let os: { restore(): void };
    beforeEach(() => {
      os = jest.replaceProperty(Platform, 'OS', 'android');
    });
    afterEach(() => os.restore());

    it('chooses Bluetooth through incall-manager', async () => {
      controller.start('audio');
      controller.setRoute('bluetooth');
      await flush();
      expect(choose).toHaveBeenCalledWith('BLUETOOTH');
      expect(controller.route).toBe('bluetooth');
    });

    it('the earpiece only turns the speaker off', () => {
      controller.start('audio');
      controller.setRoute('speaker');
      controller.setRoute('earpiece');
      expect(flag).toHaveBeenLastCalledWith(false);
      expect(choose).not.toHaveBeenCalled();
    });

    it('goes back when Bluetooth is refused, logging rather than leaving the rejection unhandled', async () => {
      choose.mockRejectedValueOnce(new Error('No BLUETOOTH audio route'));
      controller.start('audio');
      controller.setRoute('bluetooth');
      await flush();
      expect(controller.route).toBe('earpiece');
      expect(warn).toHaveBeenCalledWith('Failed to apply audio route "bluetooth":', expect.any(Error));
    });
  });

  describe('on iOS with incall-manager iOS routes', () => {
    beforeEach(() => installIncallIosRoutes());

    it('reports the device the call starts on', async () => {
      // A car connected before the call: iOS starts the call there.
      installIncallIosRoutes(deviceStatus('BLUETOOTH', undefined, 'KENWOOD'));
      controller.start('audio');
      await flush();
      expect(controller.route).toBe('bluetooth');
    });

    it('chooses every route through incall-manager', () => {
      controller.start('audio');
      controller.setRoute('bluetooth');
      controller.setRoute('earpiece');
      controller.setRoute('speaker');
      return flush().then(() =>
        expect(choose.mock.calls).toEqual([['BLUETOOTH'], ['EARPIECE'], ['SPEAKER_PHONE']])
      );
    });

    it('choosing the earpiece over the default earpiece still applies it', async () => {
      // route$ says "earpiece" from start(), but iOS may be playing through a
      // car: the choice must reach the native layer.
      controller.start('audio');
      controller.setRoute('earpiece');
      await flush();
      expect(choose).toHaveBeenCalledWith('EARPIECE');
    });

    it('goes back to the real route when a route is refused', async () => {
      installIncallIosRoutes(deviceStatus('SPEAKER_PHONE'));
      choose.mockRejectedValueOnce(new Error('BLUETOOTH is not available'));
      controller.start('video');
      controller.setRoute('bluetooth');
      await flush();
      expect(controller.route).toBe('speaker');
      // And the toggle still takes the call off the speaker.
      flag.mockClear();
      controller.setSpeakerOn(false);
      expect(flag).toHaveBeenCalledWith(false);
      expect(controller.route).toBe('earpiece');
    });

    it('mirrors what iOS reports and never writes it back', async () => {
      // incall-manager keeps its own speaker setting in step with outside
      // changes; writing reports back raced its re-apply.
      controller.start('video');
      await flush();
      flag.mockClear();
      reportDevice('EARPIECE');
      reportDevice('SPEAKER_PHONE');
      reportDevice('WIRED_HEADSET');
      reportDevice('BLUETOOTH');
      await flush();
      expect(controller.route).toBe('bluetooth');
      expect(flag).not.toHaveBeenCalled();
      expect(choose).not.toHaveBeenCalled();
    });

    it('takes a report that arrives during a choice once the choice is answered: there is no time window', async () => {
      controller.start('audio');
      await flush();
      controller.setSpeakerOn(true);
      reportDevice('BLUETOOTH'); // a car connects just after the tap
      await flush();
      expect(controller.route).toBe('bluetooth');
      // ...and a report after that is taken at once, however soon it comes.
      reportDevice('SPEAKER_PHONE');
      expect(controller.route).toBe('speaker');
    });

    it('takes the route a choice settled on from its answer', async () => {
      choose.mockResolvedValueOnce(deviceStatus('WIRED_HEADSET'));
      controller.start('audio');
      await flush();
      controller.setRoute('bluetooth');
      await flush();
      expect(controller.route).toBe('earpiece');
    });

    it('speaker off after the system picker chose the speaker returns to the earlier device', async () => {
      installIncallIosRoutes(deviceStatus('BLUETOOTH'));
      controller.start('audio');
      await flush();
      controller.setRoute('bluetooth');
      await flush();
      reportDevice('SPEAKER_PHONE');
      expect(controller.route).toBe('speaker');
      await flush();
      choose.mockClear();

      controller.setSpeakerOn(false);
      await flush();

      expect(choose).toHaveBeenCalledWith('BLUETOOTH');
      expect(controller.route).toBe('bluetooth');
    });

    it('speaker off returns to the default once that device has gone', async () => {
      installIncallIosRoutes(deviceStatus('BLUETOOTH'));
      controller.start('audio');
      await flush();
      controller.setRoute('bluetooth');
      await flush();
      reportDevice('SPEAKER_PHONE', '["EARPIECE","SPEAKER_PHONE"]');
      await flush();
      choose.mockClear();

      controller.setSpeakerOn(false);
      await flush();

      expect(choose).not.toHaveBeenCalled();
      expect(flag).toHaveBeenLastCalledWith(false);
      expect(controller.route).toBe('earpiece');
    });

    it('a wired headset replacing a receiver choice ends that choice', async () => {
      // Kept, speaker off would pin the built-in mic over the headset's.
      controller.start('audio');
      await flush();
      controller.setRoute('earpiece');
      await flush();
      reportDevice('EARPIECE');
      reportDevice('WIRED_HEADSET', '["EARPIECE","SPEAKER_PHONE","WIRED_HEADSET"]');
      controller.setSpeakerOn(true);
      await flush();
      choose.mockClear();

      controller.setSpeakerOn(false);
      await flush();

      expect(choose).not.toHaveBeenCalled();
      expect(flag).toHaveBeenLastCalledWith(false);
    });

    it('keeps a choice when iOS reports the chosen device', async () => {
      controller.start('audio');
      await flush();
      controller.setRoute('earpiece');
      await flush();
      reportDevice('EARPIECE');
      controller.setSpeakerOn(true);
      await flush();
      choose.mockClear();

      controller.setSpeakerOn(false);
      await flush();

      expect(choose).toHaveBeenCalledWith('EARPIECE');
    });

    it('stops following once the call ends: the native subscription is removed', async () => {
      controller.start('audio');
      await flush();
      expect(incallIosRoutes.addListener).toHaveBeenCalledWith('onAudioDeviceChanged');

      controller.stop();
      expect(incallIosRoutes.removeListeners).toHaveBeenCalledWith(1);

      reportDevice('SPEAKER_PHONE');
      expect(controller.route).toBe('earpiece');
    });

    it('a status read that resolves after a change does not overwrite it', async () => {
      let resolve: (status: unknown) => void = () => undefined;
      incallIosRoutes.getAudioDeviceStatus.mockImplementationOnce(
        () => new Promise((done) => (resolve = done)) as never
      );
      controller.start('audio');
      reportDevice('EARPIECE');
      resolve(deviceStatus('BLUETOOTH'));
      await flush();
      expect(controller.route).toBe('earpiece');
    });
  });
});

describe('AudioRouteController teardown', () => {
  it('does not emit while destroying, so unmounting subscribers are not pushed to', () => {
    const local = new AudioRouteController();
    local.start('audio');
    local.setSpeakerOn(true);
    const seen: string[] = [];
    local.route$.subscribe((route) => seen.push(route));
    seen.length = 0;
    local.destroy();
    expect(seen).toEqual([]);
  });

  it('destroy is idempotent', () => {
    const local = new AudioRouteController();
    local.destroy();
    expect(() => local.destroy()).not.toThrow();
  });

  it('completes route$ exactly once', () => {
    const local = new AudioRouteController();
    const complete = jest.fn();
    local.route$.subscribe({ complete });
    local.destroy();
    local.destroy();
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
