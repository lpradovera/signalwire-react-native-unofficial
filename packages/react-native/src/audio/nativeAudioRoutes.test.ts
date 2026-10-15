import { Platform } from 'react-native';

import {
  deviceStatus,
  incallIosRoutes,
  installIncallIosRoutes,
  reportDevice,
  uninstallIncallIosRoutes
} from '../../jest/mocks/incallIosRoutes';
import { audioDevices$, getAudioDeviceStatus, hasIosAudioRoutes, parseAudioDeviceStatus } from './nativeAudioRoutes';

afterEach(() => {
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
    const os = jest.replaceProperty(Platform, 'OS', 'android');
    expect(hasIosAudioRoutes()).toBe(false);
    await expect(getAudioDeviceStatus()).resolves.toBeNull();
    os.restore();
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
    expect(incallIosRoutes.addListener).toHaveBeenCalledTimes(1);

    first.unsubscribe();
    expect(incallIosRoutes.removeListeners).not.toHaveBeenCalled();
    second.unsubscribe();
    expect(incallIosRoutes.removeListeners).toHaveBeenCalledWith(1);
  });

  it('never emits without iOS routes', () => {
    const seen = jest.fn();
    audioDevices$.subscribe(seen).unsubscribe();
    expect(seen).not.toHaveBeenCalled();
  });
});
