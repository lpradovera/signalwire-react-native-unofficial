import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';

import { logger } from '@signalwire/react';
import { AudioRouteController } from './AudioRouteController';
import { resetNativeAudioRoutesForTesting } from './nativeAudioRoutes';

// jest/setup.ts installs it: this package's iOS route module.
const SWAudioRoutes = NativeModules.SWAudioRoutes as {
  chooseAudioRoute: jest.Mock;
  clearPreferredInput: jest.Mock;
};

/** What iOS reports after a route change: the AVRoutePickerView, a car connecting, ... */
function deviceChanged(selected: string, available = '["EARPIECE","SPEAKER_PHONE","BLUETOOTH"]'): void {
  DeviceEventEmitter.emit('onAudioDeviceChanged', {
    availableAudioDeviceList: available,
    selectedAudioDevice: selected,
    selectedAudioDeviceName: selected
  });
}

/** Past the window in which the controller's own route change is still settling. */
function settle(): void {
  jest.advanceTimersByTime(1000);
}

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
    expect(SWAudioRoutes.chooseAudioRoute).not.toHaveBeenCalled();
    expect(InCallManager.chooseAudioRoute).not.toHaveBeenCalled();
  });

  it('choosing the earpiece moves the call off Bluetooth (iOS)', async () => {
    controller.start('audio');
    controller.setRoute('speaker');
    controller.setRoute('earpiece');
    await Promise.resolve();
    expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenLastCalledWith(false);
    expect(SWAudioRoutes.chooseAudioRoute).toHaveBeenCalledWith('EARPIECE');
    // incall-manager has no iOS routes: it must not be asked.
    expect(InCallManager.chooseAudioRoute).not.toHaveBeenCalled();
  });

  it('a route the platform refuses is logged, not an unhandled rejection', async () => {
    SWAudioRoutes.chooseAudioRoute.mockRejectedValueOnce(new Error('No BLUETOOTH audio route is available'));
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
    expect(SWAudioRoutes.chooseAudioRoute).not.toHaveBeenCalled();
    os.restore();
  });

  it('without the native module (an app not rebuilt) iOS routes warn once and do nothing', async () => {
    const linked = NativeModules.SWAudioRoutes;
    delete NativeModules.SWAudioRoutes;
    resetNativeAudioRoutesForTesting();
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    controller.start('audio');
    controller.setRoute('bluetooth');
    controller.setRoute('earpiece');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('Rebuild the app');
    expect(controller.route).toBe('earpiece');
    warn.mockRestore();
    NativeModules.SWAudioRoutes = linked;
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
      expect(SWAudioRoutes.chooseAudioRoute).not.toHaveBeenCalled();
    });

    it('off in a video call leaves the speaker for the default route, not the receiver', () => {
      controller.start('video');
      controller.setSpeakerOn(false);
      expect(controller.route).toBe('earpiece');
      expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenLastCalledWith(false);
      expect(SWAudioRoutes.chooseAudioRoute).not.toHaveBeenCalled();
    });

    it('off returns to a Bluetooth device the user had chosen', () => {
      controller.start('audio');
      controller.setRoute('bluetooth');
      controller.setSpeakerOn(true);
      SWAudioRoutes.chooseAudioRoute.mockClear();
      controller.setSpeakerOn(false);
      expect(controller.route).toBe('bluetooth');
      expect(SWAudioRoutes.chooseAudioRoute).toHaveBeenCalledWith('BLUETOOTH');
    });

    it('off returns to the receiver when the user had chosen it', () => {
      controller.start('audio');
      controller.setRoute('earpiece');
      controller.setSpeakerOn(true);
      SWAudioRoutes.chooseAudioRoute.mockClear();
      controller.setSpeakerOn(false);
      expect(SWAudioRoutes.chooseAudioRoute).toHaveBeenCalledWith('EARPIECE');
    });

    it('forgets the last call\'s choice once the call ends', () => {
      controller.start('audio');
      controller.setRoute('bluetooth');
      controller.stop();
      controller.start('video');
      SWAudioRoutes.chooseAudioRoute.mockClear();
      controller.setSpeakerOn(false);
      expect(controller.route).toBe('earpiece');
      expect(SWAudioRoutes.chooseAudioRoute).not.toHaveBeenCalled();
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
    expect(SWAudioRoutes.chooseAudioRoute).toHaveBeenCalledWith('EARPIECE');
  });

  it('choosing Bluetooth after the speaker clears incall-manager\'s speaker flag (iOS)', () => {
    // Left at "on", incall-manager re-applies the speaker on the next audio
    // category change, under the headset.
    controller.start('audio');
    controller.setRoute('speaker');
    controller.setRoute('bluetooth');
    expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenLastCalledWith(null);
    expect(SWAudioRoutes.chooseAudioRoute).toHaveBeenCalledWith('BLUETOOTH');
  });

  describe('following the route iOS settled on', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('the system route picker choosing the speaker turns the toggle on, and tells incall-manager', () => {
      controller.start('audio');
      settle();
      deviceChanged('SPEAKER_PHONE');
      expect(controller.route).toBe('speaker');
      // Or incall-manager's next category-change re-apply would take the speaker away.
      expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenLastCalledWith(true);
    });

    it('the picker choosing the car while on the speaker clears the speaker flag', () => {
      controller.start('audio');
      controller.setSpeakerOn(true);
      settle();
      deviceChanged('BLUETOOTH');
      expect(controller.route).toBe('bluetooth');
      expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenLastCalledWith(null);
    });

    it('speaker off after the picker chose the speaker returns to where the call was', () => {
      controller.start('audio');
      settle();
      deviceChanged('BLUETOOTH');
      deviceChanged('SPEAKER_PHONE');
      controller.setSpeakerOn(false);
      expect(controller.route).toBe('bluetooth');
      expect(SWAudioRoutes.chooseAudioRoute).toHaveBeenLastCalledWith('BLUETOOTH');
    });

    it('speaker off falls back to the default when the earlier device is gone', () => {
      controller.start('audio');
      settle();
      deviceChanged('BLUETOOTH');
      // The car drops; a video-mode session falls back to the speaker.
      deviceChanged('SPEAKER_PHONE', '["EARPIECE","SPEAKER_PHONE"]');
      SWAudioRoutes.chooseAudioRoute.mockClear();
      controller.setSpeakerOn(false);
      expect(controller.route).toBe('earpiece');
      expect(SWAudioRoutes.chooseAudioRoute).not.toHaveBeenCalled();
    });

    it('ignores the route changes its own request causes while they settle', () => {
      controller.start('audio');
      settle();
      controller.setSpeakerOn(true);
      // Posted for the state before the override landed.
      deviceChanged('EARPIECE');
      expect(controller.route).toBe('speaker');
      expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenLastCalledWith(true);
    });

    it('reads a wired headset as off the speaker', () => {
      controller.start('video');
      settle();
      deviceChanged('WIRED_HEADSET', '["WIRED_HEADSET","SPEAKER_PHONE"]');
      expect(controller.route).toBe('earpiece');
    });

    it('stops following once the call ends', () => {
      controller.start('audio');
      controller.stop();
      settle();
      deviceChanged('SPEAKER_PHONE');
      expect(controller.route).toBe('earpiece');
    });
  });

  it('the default route clears a receiver pin from an earlier call (iOS)', () => {
    controller.start('audio');
    controller.setRoute('earpiece');
    controller.stop();
    SWAudioRoutes.clearPreferredInput.mockClear();
    controller.start('audio');
    expect(SWAudioRoutes.clearPreferredInput).toHaveBeenCalled();
    expect(SWAudioRoutes.chooseAudioRoute).toHaveBeenCalledTimes(1);
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

  it('setRoute("bluetooth") asks the native module for the Bluetooth route (iOS)', () => {
    controller.start('audio');
    controller.setRoute('bluetooth');
    expect(SWAudioRoutes.chooseAudioRoute).toHaveBeenCalledWith('BLUETOOTH');
    expect(controller.route).toBe('bluetooth');
  });

  it('setRoute("bluetooth") asks InCallManager for the Bluetooth route (Android)', () => {
    const os = jest.replaceProperty(Platform, 'OS', 'android');
    controller.start('audio');
    controller.setRoute('bluetooth');
    expect(InCallManager.chooseAudioRoute).toHaveBeenCalledWith('BLUETOOTH');
    expect(controller.route).toBe('bluetooth');
    os.restore();
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

  it("updateMedia moves a session started for video to voice's default route", () => {
    controller.start('video');
    (InCallManager.setForceSpeakerphoneOn as jest.Mock).mockClear();

    controller.updateMedia('audio');

    expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenCalledWith(false);
    expect(controller.route).toBe('earpiece');
    expect(InCallManager.start).toHaveBeenCalledTimes(1);
  });

  it('updateMedia keeps a route the user picked, and does nothing before start', () => {
    controller.updateMedia('video');
    expect(InCallManager.setForceSpeakerphoneOn).not.toHaveBeenCalled();

    controller.start('video');
    controller.setRoute('bluetooth');
    (InCallManager.setForceSpeakerphoneOn as jest.Mock).mockClear();
    controller.updateMedia('audio');

    expect(InCallManager.setForceSpeakerphoneOn).not.toHaveBeenCalled();
    expect(controller.route).toBe('bluetooth');
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
