import { NativeModules, Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';

import {
  deviceStatus,
  incallIosRoutes,
  installIncallIosRoutes,
  reportDevice,
  uninstallIncallIosRoutes
} from '../../jest/mocks/incallIosRoutes';
import {
  audioDevices$,
  getAudioDeviceStatus,
  hasIosAudioRoutes,
  parseAudioDeviceStatus,
  resetAudioDevicesForTesting
} from './nativeAudioRoutes';

const wrapper = InCallManager as unknown as { addListener: jest.Mock; getAudioDeviceStatus: jest.Mock };

afterEach(() => {
  // restoreAllMocks puts back a replaced Platform.OS even when a test failed.
  jest.restoreAllMocks();
  jest.useRealTimers();
  resetAudioDevicesForTesting();
  uninstallIncallIosRoutes();
  jest.clearAllMocks();
});

describe('parseAudioDeviceStatus', () => {
  it('parses the status incall-manager sends, list as a JSON string', () => {
    expect(parseAudioDeviceStatus(deviceStatus('BLUETOOTH', undefined, 'KENWOOD'))).toEqual({
      available: ['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH'],
      selected: 'BLUETOOTH',
      selectedName: 'KENWOOD'
    });
  });

  it("drops what it does not recognise, including Android's NONE", () => {
    expect(parseAudioDeviceStatus(deviceStatus('NONE', '["EARPIECE","AIRPLAY"]', ''))).toEqual({
      available: ['EARPIECE'],
      selected: null,
      selectedName: ''
    });
    expect(parseAudioDeviceStatus({ availableAudioDeviceList: 'not json' }).available).toEqual([]);
    expect(parseAudioDeviceStatus(null)).toEqual({ available: [], selected: null, selectedName: '' });
  });
});

describe('incall-manager iOS routes', () => {
  it('are absent from released incall-manager, which has no iOS getAudioDeviceStatus', async () => {
    expect(hasIosAudioRoutes()).toBe(false);
    await expect(getAudioDeviceStatus()).resolves.toBeNull();
  });

  it('are found from the native method, and read', async () => {
    installIncallIosRoutes(deviceStatus('BLUETOOTH'));
    expect(hasIosAudioRoutes()).toBe(true);
    await expect(getAudioDeviceStatus()).resolves.toMatchObject({ selected: 'BLUETOOTH' });
  });

  it('are iOS only', async () => {
    installIncallIosRoutes();
    jest.replaceProperty(Platform, 'OS', 'android');
    expect(hasIosAudioRoutes()).toBe(false);
    await expect(getAudioDeviceStatus()).resolves.toBeNull();
  });

  it('need the JS half too: an older JS bundle over a rebuilt app has no routes', () => {
    installIncallIosRoutes();
    delete (InCallManager as unknown as Record<string, unknown>).addListener;
    expect(hasIosAudioRoutes()).toBe(false);
  });

  it('need the native half too: a JS bundle with the routes over an app not rebuilt has none', () => {
    installIncallIosRoutes();
    (NativeModules as Record<string, unknown>).InCallManager = { start: jest.fn() };
    expect(hasIosAudioRoutes()).toBe(false);
  });
});

describe('audioDevices$', () => {
  it('reads once and shares one native subscription between subscribers', async () => {
    installIncallIosRoutes(deviceStatus('EARPIECE'));
    const a: (string | null)[] = [];
    const b: (string | null)[] = [];
    const first = audioDevices$.subscribe((status) => a.push(status.selected));
    const second = audioDevices$.subscribe((status) => b.push(status.selected));
    await Promise.resolve();
    await Promise.resolve();
    reportDevice('BLUETOOTH');

    expect(a).toEqual(['EARPIECE', 'BLUETOOTH']);
    expect(b).toEqual(['EARPIECE', 'BLUETOOTH']);
    expect(incallIosRoutes.getAudioDeviceStatus).toHaveBeenCalledTimes(1);
    expect(wrapper.addListener).toHaveBeenCalledTimes(1);
    first.unsubscribe();
    second.unsubscribe();
  });

  it('keeps the native subscription across a subscribe-unsubscribe-subscribe, then drops it', async () => {
    // A hook's first render reads the current value with a subscribe that
    // ends at once, and subscribes again from its effect.
    jest.useFakeTimers();
    installIncallIosRoutes(deviceStatus('EARPIECE'));
    audioDevices$.subscribe(() => undefined).unsubscribe();
    const held = audioDevices$.subscribe(() => undefined);
    await jest.advanceTimersByTimeAsync(5000);
    expect(wrapper.addListener).toHaveBeenCalledTimes(1);
    expect(incallIosRoutes.getAudioDeviceStatus).toHaveBeenCalledTimes(1);

    const remove = jest.spyOn(wrapper.addListener.mock.results[0]!.value as { remove(): void }, 'remove');
    held.unsubscribe();
    expect(remove).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(5000);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('hands a later subscriber nothing stale once it has disconnected', async () => {
    jest.useFakeTimers();
    installIncallIosRoutes(deviceStatus('BLUETOOTH'));
    audioDevices$.subscribe(() => undefined).unsubscribe();
    await jest.advanceTimersByTimeAsync(5000);
    incallIosRoutes.getAudioDeviceStatus.mockImplementation(() => new Promise(() => undefined) as never);

    const seen = jest.fn();
    audioDevices$.subscribe(seen);
    await jest.advanceTimersByTimeAsync(0);

    expect(seen).not.toHaveBeenCalled();
  });

  it("takes a read over the reports that reached it first, as incall-manager's one queue orders them", async () => {
    let resolve: (status: unknown) => void = () => undefined;
    installIncallIosRoutes();
    incallIosRoutes.getAudioDeviceStatus.mockImplementation(() => new Promise((done) => (resolve = done)) as never);
    const seen: (string | null)[] = [];
    audioDevices$.subscribe((status) => seen.push(status.selected));

    reportDevice('EARPIECE');
    resolve(deviceStatus('BLUETOOTH'));
    await Promise.resolve();
    await Promise.resolve();

    expect(seen).toEqual(['EARPIECE', 'BLUETOOTH']);
  });

  it('getAudioDeviceStatus hands a fresh read to the subscribers', async () => {
    installIncallIosRoutes(deviceStatus('EARPIECE'));
    const seen: (string | null)[] = [];
    audioDevices$.subscribe((status) => seen.push(status.selected));
    await Promise.resolve();
    await Promise.resolve();
    incallIosRoutes.getAudioDeviceStatus.mockImplementation(async () => deviceStatus('BLUETOOTH'));

    await getAudioDeviceStatus();

    expect(seen).toEqual(['EARPIECE', 'BLUETOOTH']);
  });

  it('never emits without iOS routes', () => {
    const seen = jest.fn();
    audioDevices$.subscribe(seen).unsubscribe();
    expect(seen).not.toHaveBeenCalled();
  });
});
