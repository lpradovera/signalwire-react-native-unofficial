/**
 * Android calls that react-native-callkeep's self-managed ConnectionService
 * holds: Telecom routes them, so the controller asks Telecom and follows what
 * Telecom reports, and incall-manager stays out of the route.
 */
import { DeviceEventEmitter, Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';

import { logger } from '@signalwire/react';
import {
  callAudioNative,
  callkeepNative,
  installTelecom,
  proximityNative,
  reportTelecom,
  setTelecomState,
  telecomIgnoresRequests,
  uninstallTelecom
} from '../../jest/mocks/telecom';
import { AudioRouteController, resetAudioRouteControllerForTesting } from './AudioRouteController';
import { resetAudioDevicesForTesting } from './nativeAudioRoutes';

const CALL = 'aaaa-1111';
const OTHER = 'bbbb-2222';
const flag = InCallManager.setForceSpeakerphoneOn as jest.Mock;
const choose = InCallManager.chooseAudioRoute as jest.Mock;
const setAudioRoute = callkeepNative.setAudioRoute;

const PHONE = ['EARPIECE', 'SPEAKER'];
const WITH_BT = ['EARPIECE', 'BLUETOOTH', 'SPEAKER'];
const WITH_WIRED = ['WIRED_HEADSET', 'SPEAKER'];

/** Lets the reads, Telecom's answer (a 0 ms timer) and their reports land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((done) => setTimeout(done, 1));
    for (let j = 0; j < 5; j++) {
      await Promise.resolve();
    }
  }
}

/** The routes callkeep was asked for, by callkeep's names. */
function requested(): string[] {
  return setAudioRoute.mock.calls.map(([uuid, route]) => `${uuid === CALL ? '' : `${uuid}:`}${route}`);
}

let controller: AudioRouteController;
let warn: jest.SpyInstance;
let os: { restore(): void };

beforeEach(() => {
  resetAudioRouteControllerForTesting();
  resetAudioDevicesForTesting();
  jest.clearAllMocks();
  os = jest.replaceProperty(Platform, 'OS', 'android');
  warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  installTelecom();
  controller = new AudioRouteController();
});

afterEach(() => {
  controller.destroy();
  uninstallTelecom();
  warn.mockRestore();
  os.restore();
  jest.useRealTimers();
});

describe('AudioRouteController on Android with Telecom', () => {
  describe('incall-manager', () => {
    it('never starts its session for a Telecom call, which would route the call behind Telecom', async () => {
      setTelecomState(CALL, { route: 'EARPIECE', available: PHONE });
      controller.start('audio', CALL);
      await settle();
      controller.setSpeakerOn(true);
      await settle();
      controller.setSpeakerOn(false);
      await settle();
      controller.stop();

      expect(InCallManager.start).not.toHaveBeenCalled();
      expect(InCallManager.stop).not.toHaveBeenCalled();
      expect(flag).not.toHaveBeenCalled();
      expect(choose).not.toHaveBeenCalled();
    });

    it('keeps the screen on while the call runs', async () => {
      setTelecomState(CALL, { route: 'EARPIECE', available: PHONE });
      controller.start('audio', CALL);
      await settle();
      expect(InCallManager.setKeepScreenOn).toHaveBeenLastCalledWith(true);

      controller.stop();
      expect(InCallManager.setKeepScreenOn).toHaveBeenLastCalledWith(false);
    });
  });

  describe('the screen at the ear (the proximity screen-off lock)', () => {
    /** setHeld's calls, as `hold` or `release` (`release-once-far` with RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY). */
    function lockCalls(): string[] {
      return proximityNative.setHeld.mock.calls.map(([hold, waitForFar]) =>
        hold ? 'hold' : waitForFar ? 'release-once-far' : 'release'
      );
    }

    it('holds the lock on the receiver, without waiting for a sensor event, and never uses incall-manager\'s sensor', async () => {
      setTelecomState(CALL, { route: 'EARPIECE', available: PHONE });
      controller.start('audio', CALL);
      await settle();
      expect(controller.route).toBe('earpiece');
      expect(proximityNative.held).toBe(true);
      expect(lockCalls()).toEqual(['hold']);
      expect(InCallManager.startProximitySensor).not.toHaveBeenCalled();
      expect(InCallManager.turnScreenOff).not.toHaveBeenCalled();
    });

    it('releases it at once on the speaker and holds it again back on the receiver', async () => {
      setTelecomState(CALL, { route: 'EARPIECE', available: PHONE });
      controller.start('audio', CALL);
      await settle();

      controller.setSpeakerOn(true);
      expect(lockCalls()).toEqual(['hold', 'release']);
      await settle();
      expect(controller.route).toBe('speaker');
      expect(proximityNative.held).toBe(false);

      controller.setSpeakerOn(false);
      await settle();
      expect(controller.route).toBe('earpiece');
      expect(lockCalls()).toEqual(['hold', 'release', 'hold']);
    });

    it('releases it when Telecom moves the call to Bluetooth or a wired headset', async () => {
      setTelecomState(CALL, { route: 'EARPIECE', available: WITH_BT });
      controller.start('audio', CALL);
      await settle();
      expect(proximityNative.held).toBe(true);

      reportTelecom(CALL, { route: 'BLUETOOTH', available: WITH_BT });
      await settle();
      expect(controller.route).toBe('bluetooth');
      expect(proximityNative.held).toBe(false);

      reportTelecom(CALL, { route: 'EARPIECE', available: WITH_BT });
      await settle();
      expect(proximityNative.held).toBe(true);

      reportTelecom(CALL, { route: 'WIRED_HEADSET', available: WITH_WIRED });
      await settle();
      expect(controller.route).toBe('headset');
      expect(proximityNative.held).toBe(false);
      expect(lockCalls()).toEqual(['hold', 'release', 'hold', 'release']);
    });

    it('is not held for a call Telecom starts on Bluetooth, once Telecom says so', async () => {
      setTelecomState(CALL, { route: 'BLUETOOTH', available: WITH_BT });
      controller.start('audio', CALL);
      await settle();
      expect(controller.route).toBe('bluetooth');
      expect(proximityNative.held).toBe(false);
    });

    it('is released for a video call once it is on the speaker', async () => {
      setTelecomState(CALL, { route: 'EARPIECE', available: PHONE });
      controller.start('video', CALL);
      await settle();
      // Telecom starts it on the receiver, which the route shows until the
      // speaker request lands.
      expect(controller.route).toBe('speaker');
      expect(proximityNative.held).toBe(false);
      expect(lockCalls()).toEqual(['hold', 'release']);
    });

    it('releases it when the call ends, once the phone has left the ear', async () => {
      setTelecomState(CALL, { route: 'EARPIECE', available: PHONE });
      controller.start('audio', CALL);
      await settle();

      controller.stop();
      expect(lockCalls()).toEqual(['hold', 'release-once-far']);
      expect(proximityNative.held).toBe(false);

      // Nothing after the end: a late report can't take the lock again.
      reportTelecom(CALL, { route: 'EARPIECE', available: PHONE });
      await settle();
      expect(lockCalls()).toEqual(['hold', 'release-once-far']);
    });

    it('is released for the whole call on the speaker, ending included', async () => {
      setTelecomState(CALL, { route: 'SPEAKER', available: PHONE });
      controller.start('audio', CALL);
      await settle();
      expect(controller.route).toBe('speaker');
      controller.stop();
      expect(proximityNative.held).toBe(false);
    });
  });

  describe('the screen at the ear without the package\'s lock (native code not rebuilt)', () => {
    beforeEach(() => {
      installTelecom({ proximityLock: false });
    });

    it("runs incall-manager's proximity sensor while the call runs", async () => {
      setTelecomState(CALL, { route: 'EARPIECE', available: PHONE });
      controller.start('audio', CALL);
      await settle();
      expect(InCallManager.startProximitySensor).toHaveBeenCalledTimes(1);

      controller.stop();
      expect(InCallManager.stopProximitySensor).toHaveBeenCalledTimes(1);
      expect(InCallManager.setKeepScreenOn).toHaveBeenLastCalledWith(false);
    });

    it('blanks the screen at the ear only on the receiver', async () => {
      setTelecomState(CALL, { route: 'EARPIECE', available: PHONE });
      controller.start('audio', CALL);
      await settle();

      DeviceEventEmitter.emit('Proximity', { isNear: true });
      expect(InCallManager.turnScreenOff).toHaveBeenCalledTimes(1);

      controller.setSpeakerOn(true);
      expect(InCallManager.turnScreenOn).toHaveBeenCalledTimes(1);
      await settle();

      controller.setSpeakerOn(false);
      await settle();
      expect(InCallManager.turnScreenOff).toHaveBeenCalledTimes(2);

      DeviceEventEmitter.emit('Proximity', { isNear: false });
      expect(InCallManager.turnScreenOn).toHaveBeenCalledTimes(2);
    });

    it('turns a blanked screen back on when the call ends', async () => {
      setTelecomState(CALL, { route: 'EARPIECE', available: PHONE });
      controller.start('audio', CALL);
      await settle();
      DeviceEventEmitter.emit('Proximity', { isNear: true });

      controller.stop();

      expect(InCallManager.turnScreenOn).toHaveBeenCalledTimes(1);
      DeviceEventEmitter.emit('Proximity', { isNear: false });
      DeviceEventEmitter.emit('Proximity', { isNear: true });
      expect(InCallManager.turnScreenOff).toHaveBeenCalledTimes(1);
    });
  });

  describe('the starting route', () => {
    it("is the route Telecom has the call on: a voice call on the receiver", async () => {
      setTelecomState(CALL, { route: 'EARPIECE', available: PHONE });
      controller.start('audio', CALL);
      await settle();
      expect(controller.route).toBe('earpiece');
      expect(setAudioRoute).not.toHaveBeenCalled();
    });

    it('is a Bluetooth headset Telecom put the call on', async () => {
      setTelecomState(CALL, { route: 'BLUETOOTH', available: WITH_BT });
      controller.start('audio', CALL);
      await settle();
      expect(controller.route).toBe('bluetooth');
    });

    it('puts a video call on the speaker when Telecom has it on the receiver', async () => {
      setTelecomState(CALL, { route: 'EARPIECE', available: PHONE });
      controller.start('video', CALL);
      await settle();
      expect(requested()).toEqual(['Speaker']);
      expect(controller.route).toBe('speaker');

      // Not a choice: speaker off goes back to the receiver.
      controller.setSpeakerOn(false);
      await settle();
      expect(requested()).toEqual(['Speaker', 'Phone']);
      expect(controller.route).toBe('earpiece');
    });

    it('leaves a video call on a headset', async () => {
      setTelecomState(CALL, { route: 'BLUETOOTH', available: WITH_BT });
      controller.start('video', CALL);
      await settle();
      expect(setAudioRoute).not.toHaveBeenCalled();
      expect(controller.route).toBe('bluetooth');
    });

    it('applies a speaker tap made while the call rang to the route Telecom reports', async () => {
      controller.expectSession(true);
      controller.setSpeakerOn(true);
      expect(controller.route).toBe('speaker');
      setTelecomState(CALL, { route: 'EARPIECE', available: PHONE });

      controller.start('audio', CALL);
      await settle();

      expect(requested()).toEqual(['Speaker']);
      expect(controller.route).toBe('speaker');
    });

    it("waits for Telecom's first report when the connection has no audio state yet", async () => {
      controller.start('audio', CALL);
      await settle();
      expect(controller.route).toBe('earpiece');

      reportTelecom(CALL, { route: 'BLUETOOTH', available: WITH_BT });
      await settle();
      expect(controller.route).toBe('bluetooth');
    });
  });

  describe('the speaker', () => {
    it('goes to Telecom, on and then off, and stays on the receiver', async () => {
      setTelecomState(CALL, { route: 'EARPIECE', available: PHONE });
      controller.start('audio', CALL);
      await settle();

      controller.setSpeakerOn(true);
      expect(controller.route).toBe('speaker');
      await settle();
      expect(controller.route).toBe('speaker');

      controller.setSpeakerOn(false);
      expect(controller.route).toBe('earpiece');
      await settle();

      expect(requested()).toEqual(['Speaker', 'Phone']);
      expect(controller.route).toBe('earpiece');
    });

    it('off returns to the Bluetooth headset the call was on', async () => {
      setTelecomState(CALL, { route: 'BLUETOOTH', available: WITH_BT });
      controller.start('audio', CALL);
      await settle();

      controller.setSpeakerOn(true);
      await settle();
      controller.setSpeakerOn(false);
      await settle();

      expect(requested()).toEqual(['Speaker', 'Bluetooth']);
      expect(controller.route).toBe('bluetooth');
    });

    it('off returns to the wired headset the call was on', async () => {
      setTelecomState(CALL, { route: 'WIRED_HEADSET', available: WITH_WIRED });
      controller.start('audio', CALL);
      await settle();

      controller.setSpeakerOn(true);
      await settle();
      controller.setSpeakerOn(false);
      await settle();

      expect(requested()).toEqual(['Speaker', 'Headset']);
      expect(controller.route).toBe('headset');
    });

    it('off goes to the receiver when the Bluetooth headset has gone', async () => {
      setTelecomState(CALL, { route: 'BLUETOOTH', available: WITH_BT });
      controller.start('audio', CALL);
      await settle();
      controller.setSpeakerOn(true);
      await settle();
      reportTelecom(CALL, { route: 'SPEAKER', available: PHONE });
      await settle();

      controller.setSpeakerOn(false);
      await settle();

      expect(requested()).toEqual(['Speaker', 'Phone']);
      expect(controller.route).toBe('earpiece');
    });

    it("doesn't flicker back on a report of the old route while the request is in flight", async () => {
      // callkeep's setMutedCall re-sends the current state, and Telecom may
      // report before it has switched.
      setTelecomState(CALL, { route: 'EARPIECE', available: PHONE });
      controller.start('audio', CALL);
      await settle();
      telecomIgnoresRequests();
      const seen: string[] = [];
      controller.route$.subscribe((route) => seen.push(route));

      controller.setSpeakerOn(true);
      reportTelecom(CALL, { route: 'EARPIECE', available: PHONE });
      await settle();
      reportTelecom(CALL, { route: 'SPEAKER', available: PHONE });
      await settle();

      expect(seen).toEqual(['earpiece', 'speaker']);
    });
    it('a quick on-off ends on the receiver, and later reports are followed again', async () => {
      setTelecomState(CALL, { route: 'EARPIECE', available: PHONE });
      controller.start('audio', CALL);
      await settle();

      controller.setSpeakerOn(true);
      controller.setSpeakerOn(false);
      await settle();
      expect(requested()).toEqual(['Speaker', 'Phone']);
      expect(controller.route).toBe('earpiece');

      reportTelecom(CALL, { route: 'SPEAKER', available: PHONE });
      await settle();
      expect(controller.route).toBe('speaker');
    });
  });

  describe("following Telecom's reports", () => {
    beforeEach(async () => {
      setTelecomState(CALL, { route: 'EARPIECE', available: PHONE });
      controller.start('audio', CALL);
      await settle();
    });

    it("shows a change made in the system's output switcher", async () => {
      reportTelecom(CALL, { route: 'SPEAKER', available: PHONE });
      await settle();
      expect(controller.route).toBe('speaker');

      reportTelecom(CALL, { route: 'EARPIECE', available: PHONE });
      await settle();
      expect(controller.route).toBe('earpiece');
    });

    it('shows Bluetooth connecting and disconnecting', async () => {
      reportTelecom(CALL, { route: 'BLUETOOTH', available: WITH_BT, bluetoothName: 'Pixel Buds' });
      await settle();
      expect(controller.route).toBe('bluetooth');

      reportTelecom(CALL, { route: 'EARPIECE', available: PHONE });
      await settle();
      expect(controller.route).toBe('earpiece');
    });

    it('shows a wired headset plugged in', async () => {
      reportTelecom(CALL, { route: 'WIRED_HEADSET', available: WITH_WIRED });
      await settle();
      expect(controller.route).toBe('headset');
    });

    it("speaker off after the user picked the speaker in the system UI returns to where Telecom had the call", async () => {
      reportTelecom(CALL, { route: 'BLUETOOTH', available: WITH_BT });
      await settle();
      reportTelecom(CALL, { route: 'SPEAKER', available: WITH_BT });
      await settle();

      controller.setSpeakerOn(false);
      await settle();

      expect(requested()).toEqual(['Bluetooth']);
      expect(controller.route).toBe('bluetooth');
    });

    it("ignores another call's reports", async () => {
      reportTelecom(OTHER, { route: 'SPEAKER', available: PHONE });
      await settle();
      expect(controller.route).toBe('earpiece');
    });

    it('matches the call whatever the uuid case', async () => {
      setTelecomState(CALL, { route: 'SPEAKER', available: PHONE });
      DeviceEventEmitter.emit('RNCallKeepDidChangeAudioRoute', { callUUID: CALL.toUpperCase(), output: 'SPEAKER' });
      await settle();
      expect(controller.route).toBe('speaker');
    });

    it('stops following when the call ends', async () => {
      controller.stop();
      reportTelecom(CALL, { route: 'SPEAKER', available: PHONE });
      await settle();
      expect(controller.route).toBe('earpiece');
    });
  });

  describe('routes Telecom offers', () => {
    it('asks Telecom for Bluetooth and a headset, by callkeep’s names', async () => {
      setTelecomState(CALL, { route: 'EARPIECE', available: WITH_BT });
      controller.start('audio', CALL);
      await settle();

      controller.setRoute('bluetooth');
      await settle();
      expect(controller.route).toBe('bluetooth');
      expect(requested()).toEqual(['Bluetooth']);
    });

    it("doesn't ask for a route Telecom doesn't offer the call", async () => {
      setTelecomState(CALL, { route: 'EARPIECE', available: PHONE });
      controller.start('audio', CALL);
      await settle();

      controller.setRoute('bluetooth');
      await settle();

      expect(setAudioRoute).not.toHaveBeenCalled();
      expect(controller.route).toBe('earpiece');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"bluetooth"'));
    });

    it('speaker off on a phone Telecom offers only the speaker leaves it there, asking once', async () => {
      // The Android emulator has no receiver: Telecom offers the call SPEAKER alone.
      setTelecomState(CALL, { route: 'SPEAKER', available: ['SPEAKER'] });
      controller.start('audio', CALL);
      await settle();
      expect(controller.route).toBe('speaker');

      controller.setSpeakerOn(false);
      await settle();

      expect(setAudioRoute).not.toHaveBeenCalled();
      expect(controller.route).toBe('speaker');
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('goes back to the route Telecom kept when it never moves the call', async () => {
      jest.useFakeTimers();
      setTelecomState(CALL, { route: 'EARPIECE', available: WITH_BT });
      controller.start('audio', CALL);
      await jest.advanceTimersByTimeAsync(10);
      telecomIgnoresRequests();

      controller.setRoute('bluetooth');
      expect(controller.route).toBe('bluetooth');
      await jest.advanceTimersByTimeAsync(3000);

      expect(controller.route).toBe('earpiece');
      expect(warn).toHaveBeenCalledWith('Telecom did not move the call to BLUETOOTH');

      // Nothing is held back afterwards.
      reportTelecom(CALL, { route: 'SPEAKER', available: WITH_BT });
      await jest.advanceTimersByTimeAsync(10);
      expect(controller.route).toBe('speaker');
    });
  });

  describe("without the package's reader (an app not rebuilt)", () => {
    beforeEach(() => installTelecom({ reader: false }));

    it("follows callkeep's route reports alone", async () => {
      controller.start('audio', CALL);
      reportTelecom(CALL, { route: 'BLUETOOTH', available: WITH_BT });
      await settle();
      expect(controller.route).toBe('bluetooth');

      controller.setSpeakerOn(true);
      await settle();
      expect(controller.route).toBe('speaker');
      controller.setSpeakerOn(false);
      await settle();

      expect(requested()).toEqual(['Speaker', 'Bluetooth']);
      expect(controller.route).toBe('bluetooth');
      expect(callAudioNative.getCallAudioState).not.toHaveBeenCalled();
      expect(InCallManager.start).not.toHaveBeenCalled();
    });
  });

  describe("with callkeep's full reports (the routes and the Bluetooth device in each)", () => {
    beforeEach(() => installTelecom({ fullReports: true }));

    it('takes each report as it comes, without reading the CallAudioState again', async () => {
      setTelecomState(CALL, { route: 'EARPIECE', available: PHONE });
      controller.start('audio', CALL);
      await settle();
      const reads = callAudioNative.getCallAudioState.mock.calls.length;

      reportTelecom(CALL, { route: 'BLUETOOTH', available: WITH_BT, bluetoothName: 'Pixel Buds' });
      await settle();
      expect(controller.route).toBe('bluetooth');
      reportTelecom(CALL, { route: 'EARPIECE', available: PHONE });
      await settle();
      expect(controller.route).toBe('earpiece');

      expect(callAudioNative.getCallAudioState).toHaveBeenCalledTimes(reads);
    });

    it("knows the routes Telecom offers without the package's reader", async () => {
      installTelecom({ reader: false, fullReports: true });
      controller.start('audio', CALL);
      // The emulator: Telecom offers the call the speaker alone.
      reportTelecom(CALL, { route: 'SPEAKER', available: ['SPEAKER'] });
      await settle();
      expect(controller.route).toBe('speaker');

      controller.setSpeakerOn(false);
      await settle();

      expect(setAudioRoute).not.toHaveBeenCalled();
      expect(controller.route).toBe('speaker');
      expect(callAudioNative.getCallAudioState).not.toHaveBeenCalled();
    });
  });

  describe('another call taking the session', () => {
    it('follows the call that now has it', async () => {
      setTelecomState(CALL, { route: 'EARPIECE', available: PHONE });
      controller.start('audio', CALL);
      await settle();
      setTelecomState(OTHER, { route: 'SPEAKER', available: PHONE });

      controller.start('audio', OTHER);
      await settle();
      expect(controller.route).toBe('speaker');

      reportTelecom(CALL, { route: 'EARPIECE', available: PHONE });
      await settle();
      expect(controller.route).toBe('speaker');

      controller.setSpeakerOn(false);
      await settle();
      expect(requested()).toEqual([`${OTHER}:Phone`]);
    });
  });

  describe('without Telecom', () => {
    it('uses incall-manager for a call the CallKit bridge did not hand over', () => {
      controller.start('audio');
      expect(InCallManager.start).toHaveBeenCalledWith({ media: 'audio' });
      expect(InCallManager.startProximitySensor).not.toHaveBeenCalled();
    });

    it('uses incall-manager when callkeep is not linked', () => {
      uninstallTelecom();
      controller.start('audio', CALL);
      expect(InCallManager.start).toHaveBeenCalledWith({ media: 'audio' });
    });

    it('uses incall-manager on iOS, where CallKit and incall-manager share the session', () => {
      os.restore();
      os = jest.replaceProperty(Platform, 'OS', 'ios');
      controller.start('audio', CALL);
      expect(InCallManager.start).toHaveBeenCalledWith({ media: 'audio' });
      controller.setSpeakerOn(true);
      expect(setAudioRoute).not.toHaveBeenCalled();
    });
  });
});
