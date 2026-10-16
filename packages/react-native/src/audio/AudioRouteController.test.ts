import { NativeModules, Platform } from 'react-native';
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
import { audioDevices$, resetAudioDevicesForTesting } from './nativeAudioRoutes';

const flag = InCallManager.setForceSpeakerphoneOn as jest.Mock;
const choose = InCallManager.chooseAudioRoute as jest.Mock;
const wrapper = InCallManager as unknown as { addListener: jest.Mock; getAudioDeviceStatus: jest.Mock };

/** Lets promise chains (the status read, a rejected choice) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

let controller: AudioRouteController;
let warn: jest.SpyInstance;

beforeEach(() => {
  resetAudioRouteControllerForTesting();
  resetAudioDevicesForTesting();
  jest.clearAllMocks();
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

  it('start("audio") begins an audio session off the speaker, leaving the route to incall-manager', () => {
    controller.start('audio');
    expect(InCallManager.start).toHaveBeenCalledWith({ media: 'audio' });
    expect(controller.route).toBe('earpiece');
    expect(flag).not.toHaveBeenCalled();
    expect(choose).not.toHaveBeenCalled();
  });

  it('start("video") defaults to speaker without forcing it over a headset or car', () => {
    // incall-manager's own video start uses the speaker only when nothing
    // else is connected. Forcing the speaker on top took a video call off
    // AirPods or a car.
    controller.start('video');
    expect(InCallManager.start).toHaveBeenCalledWith({ media: 'video' });
    expect(controller.route).toBe('speaker');
    expect(flag).not.toHaveBeenCalled();
  });

  it('setRoute("speaker") forces speakerphone on', () => {
    controller.start('audio');
    controller.setRoute('speaker');
    expect(flag).toHaveBeenLastCalledWith(true);
  });

  it('does not re-emit when the route is unchanged', () => {
    controller.start('audio');
    controller.setRoute('speaker');
    const seen: string[] = [];
    controller.route$.subscribe((route) => seen.push(route));
    controller.setRoute('speaker');
    expect(seen).toEqual(['speaker']);
    expect(flag).toHaveBeenCalledTimes(1);
  });

  it('refuses to start without incall-manager linked natively', () => {
    // The JS wrapper is a class instance whose methods exist either way; an
    // app installed without a rebuild has no native module behind it.
    const linked = (NativeModules as Record<string, unknown>).InCallManager;
    delete (NativeModules as Record<string, unknown>).InCallManager;
    try {
      expect(() => new AudioRouteController()).toThrow(/react-native-incall-manager/);
    } finally {
      (NativeModules as Record<string, unknown>).InCallManager = linked;
    }
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

  it('calls incall-manager in the order the controller is asked', async () => {
    installIncallIosRoutes();
    const order: string[] = [];
    choose.mockImplementation(async (route: string) => {
      order.push(`choose:${route}`);
      return deviceStatus(route);
    });
    flag.mockImplementation((on: boolean | null) => order.push(`flag:${String(on)}`));
    controller.start('audio');
    await flush();

    controller.setSpeakerOn(true);
    controller.setSpeakerOn(false);
    await flush();

    expect(order).toEqual(['choose:SPEAKER_PHONE', 'flag:false']);
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

  it('survives a route write throwing', () => {
    controller.start('audio');
    flag.mockImplementationOnce(() => {
      throw new Error('native module missing');
    });
    expect(() => controller.setRoute('speaker')).not.toThrow();
    expect(warn).toHaveBeenCalledWith('Failed to apply audio route "speaker":', expect.any(Error));
  });

  describe('before the session starts', () => {
    it('holds a choice made while a CallKit call rings, and applies it when the session starts', () => {
      controller.expectSession(true);
      controller.setSpeakerOn(true);
      expect(controller.route).toBe('speaker');
      expect(flag).not.toHaveBeenCalled();

      controller.start('audio');

      expect(controller.route).toBe('speaker');
      expect(flag).toHaveBeenCalledWith(true);
    });

    it('applies a held choice through incall-manager’s iOS routes once they can take it', async () => {
      // Before start() incall-manager refuses every choice as inactive.
      installIncallIosRoutes();
      controller.expectSession(true);
      controller.setSpeakerOn(true);
      expect(choose).not.toHaveBeenCalled();

      controller.start('audio');
      await flush();

      expect(choose).toHaveBeenCalledWith('SPEAKER_PHONE');
      expect(controller.route).toBe('speaker');
    });

    it("keeps a speaker-off made before the session, so a video call doesn't start on the speaker", () => {
      // A video call rings; the user turns the speaker on, then off again.
      controller.expectSession(true);
      controller.setSpeakerOn(true);
      controller.setSpeakerOn(false);
      expect(controller.route).toBe('earpiece');
      expect(flag).not.toHaveBeenCalled();

      controller.start('video');

      expect(controller.route).toBe('earpiece');
      expect(flag.mock.calls).toEqual([[false]]);
    });

    it('keeps a speaker-off made before the session with incall-manager’s iOS routes', async () => {
      // iOS started the video call on the speaker (nothing else connected).
      installIncallIosRoutes(deviceStatus('SPEAKER_PHONE'));
      flag.mockImplementationOnce(() =>
        incallIosRoutes.getAudioDeviceStatus.mockImplementation(async () => deviceStatus('EARPIECE'))
      );
      controller.expectSession(true);
      controller.setSpeakerOn(true);
      controller.setSpeakerOn(false);

      controller.start('video');
      await flush();

      // Speaker off is the default route, not a receiver choice.
      expect(choose).not.toHaveBeenCalled();
      expect(flag.mock.calls).toEqual([[false]]);
      expect(controller.route).toBe('earpiece');
    });

    it('writes nothing native for a call that never starts', () => {
      // After a video call, incall-manager's speaker-off outside a session
      // turned the proximity sensor on in the idle app.
      controller.expectSession(true);
      controller.setSpeakerOn(true);
      controller.setSpeakerOn(false);
      controller.stop();
      controller.start('audio');

      expect(flag).not.toHaveBeenCalled();
      expect(controller.route).toBe('earpiece');
    });

    it('forgets a held choice when no call that will start a session is left', () => {
      // An outbound call rings, the user taps the speaker, nobody answers.
      controller.expectSession(true);
      controller.setSpeakerOn(true);
      controller.expectSession(false);

      expect(controller.route).toBe('earpiece');
      controller.start('audio');
      expect(flag).not.toHaveBeenCalled();
      expect(controller.route).toBe('earpiece');
    });

    it('writes at once once no call that will start a session is left', () => {
      controller.expectSession(true);
      controller.expectSession(false);
      controller.setSpeakerOn(true);
      expect(flag).toHaveBeenCalledWith(true);
    });

    it('does not show a route it cannot write outside a session', () => {
      // With incall-manager's iOS routes too: outside a session there is only
      // the speaker setting, so Bluetooth was shown and never sent, and
      // speaker-off back to it wrote nothing, leaving the speaker forced on.
      installIncallIosRoutes();
      const seen: string[] = [];
      controller.route$.subscribe((route) => seen.push(route));
      controller.setRoute('bluetooth');
      controller.setRoute('headset');
      expect(controller.route).toBe('earpiece');

      controller.setSpeakerOn(true);
      controller.setSpeakerOn(false);

      expect(choose).not.toHaveBeenCalled();
      expect(flag.mock.calls).toEqual([[true], [false]]);
      expect(seen).toEqual(['earpiece', 'speaker', 'earpiece']);
    });

    it('on Android, writes nothing outside a session and says why once', () => {
      // A never-started incall-manager has an empty device list and refuses
      // every route, so the controller does not show one as applied.
      const os = jest.replaceProperty(Platform, 'OS', 'android');
      try {
        controller.setSpeakerOn(true);
        controller.setRoute('bluetooth');
        expect(flag).not.toHaveBeenCalled();
        expect(choose).not.toHaveBeenCalled();
        expect(controller.route).toBe('earpiece');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]![0]).toMatch(/session/);
      } finally {
        os.restore();
      }
    });

    it("a media restart (stop, then start) takes the new call's default, not the ended session's route", () => {
      // End & Accept: the bridge stops call A's session and starts B's.
      controller.expectSession(true);
      controller.start('video');
      controller.setSpeakerOn(false);
      expect(controller.route).toBe('earpiece');
      controller.stop();
      flag.mockClear();

      controller.start('video');

      expect(controller.route).toBe('speaker');
      expect(flag).not.toHaveBeenCalled();
    });

    it('a media restart does not carry a speaker choice from the ended session', () => {
      controller.expectSession(true);
      controller.start('audio');
      controller.setSpeakerOn(true);
      controller.stop();
      flag.mockClear();

      controller.start('audio');

      expect(controller.route).toBe('earpiece');
      expect(flag).not.toHaveBeenCalled();
    });

    it("keeps a choice held for a ringing call through another call's stop(), for that call's start()", async () => {
      // The other call's session hadn't reported yet when the tap was made,
      // so the tap is held, not applied; that session then ends while the
      // ringing call is still live.
      installIncallIosRoutes();
      incallIosRoutes.getAudioDeviceStatus.mockImplementationOnce(() => new Promise(() => undefined) as never);
      controller.expectSession(true);
      controller.start('audio');
      controller.setSpeakerOn(true);
      controller.stop();
      expect(controller.route).toBe('speaker');

      controller.start('audio');
      await flush();

      expect(choose).toHaveBeenCalledWith('SPEAKER_PHONE');
      expect(controller.route).toBe('speaker');
    });

    it('keeps a held choice through a stop() with no session while a call that will start one is live', () => {
      controller.expectSession(true);
      controller.setSpeakerOn(true);
      controller.stop();
      expect(controller.route).toBe('speaker');
      controller.start('audio');
      expect(flag.mock.calls).toEqual([[true]]);
    });

    it('drops a held choice at stop() once no call that will start a session is left', () => {
      controller.expectSession(true);
      controller.setSpeakerOn(true);
      controller.expectSession(false);
      controller.stop();
      controller.start('audio');
      expect(flag).not.toHaveBeenCalled();
      expect(controller.route).toBe('earpiece');
    });

    it('still turns the speaker on and off in an app that starts no session', () => {
      // Without CallKit nothing calls start(); speaker on/off is all
      // incall-manager does outside a session, and it works there.
      controller.setSpeakerOn(true);
      controller.setSpeakerOn(false);
      expect(flag.mock.calls).toEqual([[true], [false]]);
    });
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

    it('warns once per process, not once per controller or bundle copy', () => {
      // Two isolated module registries stand for two tsup bundle copies, each
      // with its own logger.
      const copies: jest.SpyInstance[] = [];
      const load = (): typeof import('./AudioRouteController') => {
        let copy: typeof import('./AudioRouteController') | undefined;
        jest.isolateModules(() => {
          const copyLogger = jest.requireActual<typeof import('@signalwire/react')>('@signalwire/react').logger;
          copies.push(jest.spyOn(copyLogger, 'warn').mockImplementation(() => undefined));
          copy = jest.requireActual<typeof import('./AudioRouteController')>('./AudioRouteController');
        });
        return copy!;
      };
      const first = load();
      const second = load();

      new first.AudioRouteController().setRoute('bluetooth');
      new second.AudioRouteController().setRoute('bluetooth');
      controller.setRoute('bluetooth');

      const warned = [warn, ...copies].reduce((sum, spy) => sum + spy.mock.calls.length, 0);
      expect(warned).toBe(1);
      copies.forEach((spy) => spy.mockRestore());
    });

    it('setRoute("headset") turns the speaker off, which a plugged-in headset then takes', () => {
      controller.start('video');
      controller.setRoute('headset');
      expect(flag).toHaveBeenLastCalledWith(false);
      expect(choose).not.toHaveBeenCalled();
      expect(controller.route).toBe('headset');
      expect(warn).not.toHaveBeenCalled();
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

    /** What incall-manager's own start reports on Android: the device it put the call on. */
    const ANDROID_LIST = '["EARPIECE","SPEAKER_PHONE","BLUETOOTH"]';

    it("follows incall-manager's device reports, so a video call on a headset reads as one", () => {
      // incall-manager puts a video call on a connected Bluetooth headset
      // (BLUETOOTH is preferred over the video default, the speaker).
      controller.start('video');
      reportDevice('BLUETOOTH', ANDROID_LIST);
      expect(controller.route).toBe('bluetooth');

      // CallControls' toggle: the speaker is off, so the tap turns it on,
      // rather than "off" (the earpiece), which took the call off the headset.
      controller.setSpeakerOn(controller.route !== 'speaker');
      expect(flag.mock.calls).toEqual([[true]]);

      reportDevice('WIRED_HEADSET', '["EARPIECE","SPEAKER_PHONE","WIRED_HEADSET"]');
      expect(controller.route).toBe('headset');
    });

    it("holds a tap made before the session's first report, then applies it to the reported route", () => {
      // The video call's 'speaker' is only incall-manager's default until
      // its start reports the device: here the headset.
      controller.start('video');
      controller.setSpeakerOn(false);
      expect(flag).not.toHaveBeenCalled();

      reportDevice('BLUETOOTH', ANDROID_LIST);

      expect(flag).not.toHaveBeenCalled();
      expect(choose).not.toHaveBeenCalled();
      expect(controller.route).toBe('bluetooth');
    });

    it("applies a choice held for the session once incall-manager has reported the call's devices", () => {
      // incall-manager 4.2.x fills its device list on the UI thread after
      // start(); a write in the same tick met an empty list and was dropped.
      controller.expectSession(true);
      controller.setSpeakerOn(true);
      controller.start('audio');
      expect(flag).not.toHaveBeenCalled();

      reportDevice('EARPIECE', ANDROID_LIST);

      expect(flag.mock.calls).toEqual([[true]]);
      expect(controller.route).toBe('speaker');
    });

    it('applies a held choice anyway when no report comes', () => {
      jest.useFakeTimers();
      try {
        controller.expectSession(true);
        controller.setSpeakerOn(true);
        controller.start('audio');
        jest.advanceTimersByTime(1000);
        expect(flag.mock.calls).toEqual([[true]]);
      } finally {
        jest.useRealTimers();
      }
    });

    it('speaker off returns a voice call to the headset Android had chosen, at its default', () => {
      // false is incall-manager's "speaker off": EARPIECE as the user's
      // selection, which Android prefers over the Bluetooth headset.
      controller.start('audio');
      reportDevice('BLUETOOTH', ANDROID_LIST);
      controller.setSpeakerOn(true);
      reportDevice('SPEAKER_PHONE', ANDROID_LIST);
      flag.mockClear();

      controller.setSpeakerOn(false);

      expect(flag.mock.calls).toEqual([[null]]);
      expect(choose).not.toHaveBeenCalled();
      expect(controller.route).toBe('bluetooth');
    });

    it('speaker off takes a voice call on the receiver back to its default, which is the receiver', () => {
      controller.start('audio');
      reportDevice('EARPIECE', ANDROID_LIST);
      controller.setSpeakerOn(true);
      flag.mockClear();
      controller.setSpeakerOn(false);
      expect(flag.mock.calls).toEqual([[null]]);
    });

    it("speaker off in a video call forces the receiver: the video call's default is the speaker", () => {
      controller.start('video');
      reportDevice('SPEAKER_PHONE', ANDROID_LIST);
      controller.setSpeakerOn(false);
      expect(flag.mock.calls).toEqual([[false]]);
      expect(controller.route).toBe('earpiece');
    });

    it('goes back to the reported route when a choice held for the session is refused', async () => {
      // The user picks Bluetooth while the call rings; when it connects there
      // is no Bluetooth device. The refusal used to "go back" to the held
      // route itself, which route$ already showed.
      choose.mockResolvedValueOnce(deviceStatus('EARPIECE', '["EARPIECE","SPEAKER_PHONE"]'));
      controller.expectSession(true);
      controller.setRoute('bluetooth');
      controller.start('audio');
      reportDevice('EARPIECE', '["EARPIECE","SPEAKER_PHONE"]');
      await flush();

      expect(choose).toHaveBeenCalledWith('BLUETOOTH');
      expect(controller.route).toBe('earpiece');
    });

    it('goes back to the confirmed route when two choices in flight are both refused', async () => {
      const answers: ((status: unknown) => void)[] = [];
      choose.mockImplementation(() => new Promise((done) => answers.push(done)));
      controller.start('audio');
      reportDevice('EARPIECE', '["EARPIECE","SPEAKER_PHONE"]');

      controller.setRoute('bluetooth');
      controller.setRoute('headset');
      answers[0]!(deviceStatus('EARPIECE', '["EARPIECE","SPEAKER_PHONE"]'));
      await flush();
      answers[1]!(deviceStatus('EARPIECE', '["EARPIECE","SPEAKER_PHONE"]'));
      await flush();

      expect(controller.route).toBe('earpiece');
    });

    it('a refusal of a choice a later write replaced does not undo that write', async () => {
      // Video call on the speaker: Headset, Earpiece (a write), Headset again.
      const answers: ((status: unknown) => void)[] = [];
      choose.mockImplementation(() => new Promise((done) => answers.push(done)));
      controller.start('video');
      reportDevice('SPEAKER_PHONE', '["EARPIECE","SPEAKER_PHONE"]');

      controller.setRoute('headset');
      controller.setRoute('earpiece');
      controller.setRoute('headset');
      answers[0]!(deviceStatus('EARPIECE', '["EARPIECE","SPEAKER_PHONE"]'));
      await flush();
      answers[1]!(deviceStatus('EARPIECE', '["EARPIECE","SPEAKER_PHONE"]'));
      await flush();

      expect(flag.mock.calls).toEqual([[false]]);
      expect(controller.route).toBe('earpiece');
    });

    it('chooses Bluetooth through incall-manager', async () => {
      choose.mockResolvedValueOnce(deviceStatus('BLUETOOTH'));
      controller.start('audio');
      reportDevice('EARPIECE', ANDROID_LIST);
      controller.setRoute('bluetooth');
      await flush();
      expect(choose).toHaveBeenCalledWith('BLUETOOTH');
      expect(controller.route).toBe('bluetooth');
    });

    it('goes back when there is no Bluetooth device: Android answers instead of refusing', async () => {
      // incall-manager on Android logs "Can not select BLUETOOTH" and
      // resolves with the unchanged status.
      choose.mockResolvedValueOnce(deviceStatus('EARPIECE', '["EARPIECE","SPEAKER_PHONE"]'));
      controller.start('audio');
      reportDevice('EARPIECE', '["EARPIECE","SPEAKER_PHONE"]');
      controller.setRoute('bluetooth');
      await flush();
      expect(controller.route).toBe('earpiece');
    });

    it('speaker off leaves the speaker when the Bluetooth device went away', async () => {
      choose.mockResolvedValueOnce(deviceStatus('BLUETOOTH'));
      controller.start('audio');
      reportDevice('EARPIECE', ANDROID_LIST);
      controller.setRoute('bluetooth');
      await flush();
      // Speaker on is setForceSpeakerphoneOn on Android, not a choice: it
      // reads no answer.
      controller.setSpeakerOn(true);
      await flush();
      // The headset drops before any report says so; Android's answer to the
      // speaker-off choice (Bluetooth again) is the only one queued.
      choose.mockResolvedValueOnce(deviceStatus('SPEAKER_PHONE', '["EARPIECE","SPEAKER_PHONE"]'));
      flag.mockClear();

      controller.setSpeakerOn(false);
      await flush();

      expect(choose.mock.calls).toEqual([['BLUETOOTH'], ['BLUETOOTH']]);
      expect(controller.route).toBe('earpiece');
      // The voice call's default: the receiver, now that no headset is there.
      expect(flag).toHaveBeenLastCalledWith(null);
    });

    it('speaker off skips a Bluetooth device a report said has gone', async () => {
      choose.mockResolvedValueOnce(deviceStatus('BLUETOOTH'));
      controller.start('audio');
      reportDevice('EARPIECE', ANDROID_LIST);
      controller.setRoute('bluetooth');
      await flush();
      controller.setSpeakerOn(true);
      reportDevice('SPEAKER_PHONE', '["EARPIECE","SPEAKER_PHONE"]');
      choose.mockClear();
      flag.mockClear();

      controller.setSpeakerOn(false);
      await flush();

      expect(choose).not.toHaveBeenCalled();
      expect(flag.mock.calls).toEqual([[null]]);
      expect(controller.route).toBe('earpiece');
    });

    it('chooses a wired headset through incall-manager, and goes back without one', async () => {
      choose.mockResolvedValueOnce(deviceStatus('WIRED_HEADSET', '["SPEAKER_PHONE","WIRED_HEADSET"]'));
      controller.start('audio');
      reportDevice('EARPIECE', '["EARPIECE","SPEAKER_PHONE","WIRED_HEADSET"]');
      controller.setRoute('headset');
      await flush();
      expect(choose).toHaveBeenLastCalledWith('WIRED_HEADSET');
      expect(controller.route).toBe('headset');

      choose.mockResolvedValueOnce(deviceStatus('EARPIECE', '["EARPIECE","SPEAKER_PHONE"]'));
      controller.setRoute('speaker');
      controller.setRoute('headset');
      await flush();
      expect(controller.route).toBe('speaker');
    });

    it('the earpiece only turns the speaker off', () => {
      controller.start('audio');
      reportDevice('EARPIECE', ANDROID_LIST);
      controller.setRoute('speaker');
      controller.setRoute('earpiece');
      expect(flag).toHaveBeenLastCalledWith(false);
      expect(choose).not.toHaveBeenCalled();
    });

    it('goes back when Bluetooth is refused, logging rather than leaving the rejection unhandled', async () => {
      choose.mockRejectedValueOnce(new Error('No BLUETOOTH audio route'));
      controller.start('audio');
      reportDevice('EARPIECE', ANDROID_LIST);
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

    it('reports a wired or USB-C headset as the headset, not the earpiece', async () => {
      installIncallIosRoutes(deviceStatus('WIRED_HEADSET', '["SPEAKER_PHONE","WIRED_HEADSET"]', 'Headphones'));
      controller.start('audio');
      await flush();
      expect(controller.route).toBe('headset');
    });

    it('chooses every route through incall-manager', async () => {
      controller.start('audio');
      await flush();
      controller.setRoute('bluetooth');
      controller.setRoute('earpiece');
      controller.setRoute('speaker');
      controller.setRoute('headset');
      return flush().then(() =>
        expect(choose.mock.calls).toEqual([['BLUETOOTH'], ['EARPIECE'], ['SPEAKER_PHONE'], ['WIRED_HEADSET']])
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
      expect(controller.route).toBe('headset');
      reportDevice('BLUETOOTH');
      await flush();
      expect(controller.route).toBe('bluetooth');
      expect(flag).not.toHaveBeenCalled();
      expect(choose).not.toHaveBeenCalled();
    });

    it("takes a choice's answer over a report sent before it", async () => {
      // incall-manager answers on the queue it reports from, so a report that
      // reached JS before the answer is older than it.
      controller.start('audio');
      await flush();
      controller.setSpeakerOn(true);
      reportDevice('BLUETOOTH'); // the car, just before incall-manager ran the choice
      await flush();
      expect(controller.route).toBe('speaker');
      // ...and a report after the answer is taken at once, however soon it comes.
      reportDevice('BLUETOOTH');
      expect(controller.route).toBe('bluetooth');
    });

    it('takes a report that arrived during a choice when the answer names no known output', async () => {
      // An AirPlay or HDMI output is none of the four routes ("").
      choose.mockResolvedValueOnce(deviceStatus(''));
      controller.start('audio');
      await flush();
      controller.setSpeakerOn(true);
      reportDevice('BLUETOOTH');
      await flush();
      expect(controller.route).toBe('bluetooth');
    });

    it('ignores the status from before the call until its own read comes back', async () => {
      // A hook kept mounted holds the previous call's last status; the
      // shared feed replays it to the next call's subscription.
      installIncallIosRoutes(deviceStatus('BLUETOOTH'));
      const held = audioDevices$.subscribe(() => undefined);
      await flush();
      incallIosRoutes.getAudioDeviceStatus.mockImplementation(async () => deviceStatus('EARPIECE'));
      const seen: string[] = [];
      controller.route$.subscribe((route) => seen.push(route));

      controller.start('audio');
      await flush();

      expect(seen).not.toContain('bluetooth');
      expect(controller.route).toBe('earpiece');
      held.unsubscribe();
    });

    it("keeps the previous call's late answer out of the next call", async () => {
      let answer: (status: unknown) => void = () => undefined;
      controller.start('audio');
      await flush();
      choose.mockImplementationOnce(() => new Promise((done) => (answer = done)));
      controller.setSpeakerOn(true);
      controller.stop();
      controller.start('audio');
      await flush();

      answer(deviceStatus('SPEAKER_PHONE'));
      await flush();

      expect(controller.route).toBe('earpiece');
      flag.mockClear();
      choose.mockClear();
      controller.setSpeakerOn(true);
      await flush();
      expect(choose).toHaveBeenCalledWith('SPEAKER_PHONE');
    });

    it('reads where a speaker write that moved nothing left the call', async () => {
      // An iPad has no receiver: speaker off leaves the call on the speaker,
      // and incall-manager reports nothing because nothing changed.
      installIncallIosRoutes(deviceStatus('SPEAKER_PHONE', '["SPEAKER_PHONE"]'));
      controller.start('audio');
      await flush();
      expect(controller.route).toBe('speaker');

      controller.setSpeakerOn(false);
      await flush();

      expect(controller.route).toBe('speaker');
    });

    it('speaker off returns a call to the car the speaker replaced, at incall-manager’s default', async () => {
      // false would put a video call in voice chat mode on the car, and on
      // the receiver once the car leaves. null leaves the choice to iOS.
      installIncallIosRoutes(deviceStatus('BLUETOOTH', undefined, 'KENWOOD'));
      controller.start('video');
      await flush();
      controller.setSpeakerOn(true);
      await flush();
      flag.mockClear();
      incallIosRoutes.getAudioDeviceStatus.mockImplementation(async () => deviceStatus('BLUETOOTH'));

      controller.setSpeakerOn(false);
      await flush();

      expect(flag).toHaveBeenLastCalledWith(null);
      expect(controller.route).toBe('bluetooth');
    });

    it('speaker off returns a call that was on the receiver with speaker off', async () => {
      controller.start('video');
      await flush();
      reportDevice('EARPIECE');
      controller.setSpeakerOn(true);
      await flush();
      flag.mockClear();

      controller.setSpeakerOn(false);
      await flush();

      expect(flag).toHaveBeenLastCalledWith(false);
    });

    it('takes the route a choice settled on from its answer', async () => {
      choose.mockResolvedValueOnce(deviceStatus('WIRED_HEADSET'));
      controller.start('audio');
      await flush();
      controller.setRoute('bluetooth');
      await flush();
      expect(controller.route).toBe('headset');
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
      incallIosRoutes.getAudioDeviceStatus.mockImplementation(async () => deviceStatus('EARPIECE'));

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
      const seen: string[] = [];
      const sub = controller.route$.subscribe((route) => seen.push(route));
      seen.length = 0;
      reportDevice('WIRED_HEADSET', '["EARPIECE","SPEAKER_PHONE","WIRED_HEADSET"]');
      sub.unsubscribe();
      expect(seen).toEqual(['headset']);
      controller.setSpeakerOn(true);
      await flush();
      choose.mockClear();
      incallIosRoutes.getAudioDeviceStatus.mockImplementation(async () =>
        deviceStatus('WIRED_HEADSET', '["EARPIECE","SPEAKER_PHONE","WIRED_HEADSET"]')
      );

      controller.setSpeakerOn(false);
      await flush();

      // Back to the headset at incall-manager's default, without the receiver pin.
      expect(choose).not.toHaveBeenCalled();
      expect(flag).toHaveBeenLastCalledWith(null);
      expect(controller.route).toBe('headset');
    });

    it('speaker off returns to a chosen headset by choosing it again', async () => {
      installIncallIosRoutes(deviceStatus('EARPIECE', '["SPEAKER_PHONE","WIRED_HEADSET"]'));
      choose.mockImplementation(async (route: string) => deviceStatus(route, '["SPEAKER_PHONE","WIRED_HEADSET"]'));
      controller.start('audio');
      await flush();
      controller.setRoute('headset');
      await flush();
      reportDevice('WIRED_HEADSET', '["SPEAKER_PHONE","WIRED_HEADSET"]');
      controller.setSpeakerOn(true);
      await flush();
      choose.mockClear();

      controller.setSpeakerOn(false);
      await flush();

      expect(choose).toHaveBeenCalledWith('WIRED_HEADSET');
      expect(controller.route).toBe('headset');
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

    it('stops following once the call ends', async () => {
      controller.start('audio');
      await flush();
      expect(wrapper.addListener).toHaveBeenCalledWith('onAudioDeviceChanged', expect.any(Function));

      controller.stop();
      reportDevice('SPEAKER_PHONE');

      expect(controller.route).toBe('earpiece');
    });

    it('reads the status once per call when nothing else follows the devices', async () => {
      // The feed's connect read comes after incall-manager's start: it is the
      // call's own status, so no second read is needed.
      controller.start('audio');
      await flush();
      expect(incallIosRoutes.getAudioDeviceStatus).toHaveBeenCalledTimes(1);
    });

    it('reads the status once per call when a mounted hook already follows the devices', async () => {
      const held = audioDevices$.subscribe(() => undefined);
      await flush();
      incallIosRoutes.getAudioDeviceStatus.mockClear();
      controller.start('audio');
      await flush();
      expect(incallIosRoutes.getAudioDeviceStatus).toHaveBeenCalledTimes(1);
      held.unsubscribe();
    });

    it("holds a tap made before the call's status read returns, then applies it to the reported route", async () => {
      // A video call iOS started on a wired headset reads 'speaker' (the
      // media default) until the read returns; a speaker-off written then
      // stayed, putting the call in voice chat mode on the headset.
      let resolve: (status: unknown) => void = () => undefined;
      incallIosRoutes.getAudioDeviceStatus.mockImplementation(
        () => new Promise((done) => (resolve = done)) as never
      );
      controller.start('video');
      controller.setSpeakerOn(false);
      expect(flag).not.toHaveBeenCalled();

      resolve(deviceStatus('WIRED_HEADSET', '["SPEAKER_PHONE","WIRED_HEADSET"]'));
      await flush();

      expect(flag).not.toHaveBeenCalled();
      expect(choose).not.toHaveBeenCalled();
      expect(controller.route).toBe('headset');
    });

    it("takes the call's status read over a report that reached it first", async () => {
      // incall-manager answers the read on the queue it reports from, so a
      // report delivered before the answer was sent before it.
      let resolve: (status: unknown) => void = () => undefined;
      incallIosRoutes.getAudioDeviceStatus.mockImplementation(
        () => new Promise((done) => (resolve = done)) as never
      );
      controller.start('audio');
      reportDevice('EARPIECE');
      resolve(deviceStatus('BLUETOOTH'));
      await flush();
      expect(controller.route).toBe('bluetooth');
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
