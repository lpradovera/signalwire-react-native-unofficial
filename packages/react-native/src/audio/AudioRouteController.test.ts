import { Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';

import { logger } from '@signalwire/react';
import { AudioRouteController } from './AudioRouteController';

describe('AudioRouteController', () => {
  let controller: AudioRouteController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AudioRouteController();
  });

  afterEach(() => controller.destroy());

  it('defaults to earpiece before a session starts', () => {
    expect(controller.route).toBe('earpiece');
  });

  it('start("audio") begins an audio session on the earpiece', () => {
    controller.start('audio');
    expect(InCallManager.start).toHaveBeenCalledWith({ media: 'audio' });
    expect(controller.route).toBe('earpiece');
    expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenCalledWith(false);
  });

  it('start("video") defaults to speaker', () => {
    controller.start('video');
    expect(InCallManager.start).toHaveBeenCalledWith({ media: 'video' });
    expect(controller.route).toBe('speaker');
    expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenCalledWith(true);
  });

  it('start leaves a connected Bluetooth device in charge (iOS)', () => {
    controller.start('audio');
    expect(InCallManager.chooseAudioRoute).not.toHaveBeenCalled();
  });

  it('choosing the earpiece moves the call off Bluetooth (iOS)', async () => {
    controller.start('audio');
    controller.setRoute('speaker');
    controller.setRoute('earpiece');
    await Promise.resolve();
    expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenLastCalledWith(false);
    expect(InCallManager.chooseAudioRoute).toHaveBeenCalledWith('EARPIECE');
  });

  it('a route the platform refuses is logged, not an unhandled rejection', async () => {
    (InCallManager.chooseAudioRoute as jest.Mock).mockRejectedValueOnce(new Error('No BLUETOOTH audio route'));
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    controller.start('audio');
    controller.setRoute('bluetooth');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.route).toBe('bluetooth');
    expect(warn).toHaveBeenCalledWith('Failed to apply audio route "bluetooth":', expect.any(Error));
    warn.mockRestore();
  });

  it('choosing the earpiece on Android only turns the speaker off', () => {
    const os = jest.replaceProperty(Platform, 'OS', 'android');
    controller.start('audio');
    controller.setRoute('speaker');
    controller.setRoute('earpiece');
    expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenLastCalledWith(false);
    expect(InCallManager.chooseAudioRoute).not.toHaveBeenCalled();
    os.restore();
  });

  describe('the speaker toggle', () => {
    it('off returns to the default route, leaving a connected headset or car in charge (iOS)', async () => {
      controller.start('audio');
      controller.setSpeakerOn(true);
      controller.setSpeakerOn(false);
      await Promise.resolve();
      expect(controller.route).toBe('earpiece');
      expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenLastCalledWith(false);
      // setRoute('earpiece') would choose the receiver and pull the call off the car.
      expect(InCallManager.chooseAudioRoute).not.toHaveBeenCalled();
    });

    it('off in a video call leaves the speaker for the default route, not the receiver', () => {
      controller.start('video');
      controller.setSpeakerOn(false);
      expect(controller.route).toBe('earpiece');
      expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenLastCalledWith(false);
      expect(InCallManager.chooseAudioRoute).not.toHaveBeenCalled();
    });

    it('off returns to a Bluetooth device the user had chosen', () => {
      controller.start('audio');
      controller.setRoute('bluetooth');
      controller.setSpeakerOn(true);
      (InCallManager.chooseAudioRoute as jest.Mock).mockClear();
      controller.setSpeakerOn(false);
      expect(controller.route).toBe('bluetooth');
      expect(InCallManager.chooseAudioRoute).toHaveBeenCalledWith('BLUETOOTH');
    });

    it('off returns to the receiver when the user had chosen it', () => {
      controller.start('audio');
      controller.setRoute('earpiece');
      controller.setSpeakerOn(true);
      (InCallManager.chooseAudioRoute as jest.Mock).mockClear();
      controller.setSpeakerOn(false);
      expect(InCallManager.chooseAudioRoute).toHaveBeenCalledWith('EARPIECE');
    });

    it('forgets the last call\'s choice once the call ends', () => {
      controller.start('audio');
      controller.setRoute('bluetooth');
      controller.stop();
      controller.start('video');
      (InCallManager.chooseAudioRoute as jest.Mock).mockClear();
      controller.setSpeakerOn(false);
      expect(controller.route).toBe('earpiece');
      expect(InCallManager.chooseAudioRoute).not.toHaveBeenCalled();
    });

    it('on and off are no-ops when already there', () => {
      controller.start('audio');
      (InCallManager.setForceSpeakerphoneOn as jest.Mock).mockClear();
      controller.setSpeakerOn(false);
      controller.setSpeakerOn(true);
      controller.setSpeakerOn(true);
      expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenCalledTimes(1);
    });
  });

  it('choosing the earpiece over the default earpiece still applies it (iOS)', () => {
    // route$ says "earpiece" from start(), but iOS may be playing through a
    // car: the choice must reach the native layer, not be dropped as unchanged.
    controller.start('audio');
    controller.setRoute('earpiece');
    expect(InCallManager.chooseAudioRoute).toHaveBeenCalledWith('EARPIECE');
  });

  it('choosing Bluetooth after the speaker clears incall-manager\'s speaker flag (iOS)', () => {
    // Left at "on", incall-manager re-applies the speaker on the next audio
    // category change, under the headset.
    controller.start('audio');
    controller.setRoute('speaker');
    controller.setRoute('bluetooth');
    expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenLastCalledWith(null);
    expect(InCallManager.chooseAudioRoute).toHaveBeenCalledWith('BLUETOOTH');
  });

  it('setRoute("speaker") forces speakerphone on', () => {
    controller.start('audio');
    controller.setRoute('speaker');
    expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenLastCalledWith(true);
    expect(controller.route).toBe('speaker');
  });

  it('setRoute("earpiece") forces speakerphone off', () => {
    controller.start('video');
    controller.setRoute('earpiece');
    expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenLastCalledWith(false);
    expect(controller.route).toBe('earpiece');
  });

  it('setRoute("bluetooth") asks InCallManager to choose the Bluetooth route', () => {
    controller.start('audio');
    controller.setRoute('bluetooth');
    expect(InCallManager.chooseAudioRoute).toHaveBeenCalledWith('BLUETOOTH');
    expect(controller.route).toBe('bluetooth');
  });

  it('emits every route change on route$', () => {
    const seen: string[] = [];
    const subscription = controller.route$.subscribe((route) => seen.push(route));

    controller.start('audio');
    controller.setRoute('speaker');
    controller.setRoute('earpiece');

    subscription.unsubscribe();
    expect(seen).toEqual(['earpiece', 'earpiece', 'speaker', 'earpiece']);
  });

  it('does not re-emit when the route is unchanged', () => {
    const seen: string[] = [];
    const subscription = controller.route$.subscribe((route) => seen.push(route));

    controller.setRoute('speaker');
    controller.setRoute('speaker');

    subscription.unsubscribe();
    expect(seen).toEqual(['earpiece', 'speaker']);
  });

  it('stop ends the session and resets to earpiece', () => {
    controller.start('video');
    controller.stop();
    expect(InCallManager.stop).toHaveBeenCalled();
    expect(controller.route).toBe('earpiece');
  });

  it('stop without start does not throw', () => {
    expect(() => controller.stop()).not.toThrow();
  });

  it('survives InCallManager throwing', () => {
    (InCallManager.setForceSpeakerphoneOn as jest.Mock).mockImplementationOnce(() => {
      throw new Error('audio session busy');
    });
    expect(() => controller.setRoute('speaker')).not.toThrow();
  });

  it('does not restart an already-started session or reset the route', () => {
    // An inbound call starts audio on the native answer and again when it
    // reaches `connected`. A second start would re-run InCallManager and force
    // the route back to its default, discarding the user's speaker toggle.
    controller.start('audio');
    controller.setRoute('speaker');
    (InCallManager.start as jest.Mock).mockClear();

    controller.start('audio');

    expect(InCallManager.start).not.toHaveBeenCalled();
    expect(controller.route).toBe('speaker');
  });
});

describe('AudioRouteController teardown', () => {
  it('does not emit while destroying, so unmounting subscribers are not pushed to', () => {
    const controller = new AudioRouteController();
    const seen: string[] = [];
    const subscription = controller.route$.subscribe((route) => seen.push(route));

    controller.start('video');
    controller.destroy();

    subscription.unsubscribe();
    // 'earpiece' seed then 'speaker' from start(); the teardown reset is silent.
    expect(seen).toEqual(['earpiece', 'speaker']);
  });

  it('destroy is idempotent', () => {
    const controller = new AudioRouteController();
    controller.destroy();
    expect(() => controller.destroy()).not.toThrow();
  });

  it('completes route$ exactly once', () => {
    const controller = new AudioRouteController();
    const completed = jest.fn();
    controller.route$.subscribe({ complete: completed });

    controller.destroy();
    controller.destroy();

    expect(completed).toHaveBeenCalledTimes(1);
  });
});
