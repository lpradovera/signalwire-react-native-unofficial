import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';

import {
  addAudioDeviceChangeListener,
  getAudioDeviceStatus,
  parseAudioDeviceStatus
} from './nativeAudioRoutes';

// jest/setup.ts installs it: this package's iOS route module.
const SWAudioRoutes = NativeModules.SWAudioRoutes as { addListener: jest.Mock };

describe('nativeAudioRoutes', () => {
  it('parses the status the native side sends, list as a JSON string', () => {
    expect(
      parseAudioDeviceStatus({
        availableAudioDeviceList: '["EARPIECE","SPEAKER_PHONE","BLUETOOTH"]',
        selectedAudioDevice: 'BLUETOOTH',
        selectedAudioDeviceName: 'KENWOOD'
      })
    ).toEqual({ available: ['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH'], selected: 'BLUETOOTH', selectedName: 'KENWOOD' });
  });

  it('drops what it does not recognise rather than passing it on', () => {
    expect(
      parseAudioDeviceStatus({ availableAudioDeviceList: '["EARPIECE","AIRPLAY"]', selectedAudioDevice: '' })
    ).toEqual({ available: ['EARPIECE'], selected: null, selectedName: '' });
    expect(parseAudioDeviceStatus({ availableAudioDeviceList: 'not json' }).available).toEqual([]);
    expect(parseAudioDeviceStatus(null)).toEqual({ available: [], selected: null, selectedName: '' });
  });

  it('reads the current devices on iOS', async () => {
    await expect(getAudioDeviceStatus()).resolves.toEqual({
      available: ['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH'],
      selected: 'BLUETOOTH',
      selectedName: 'KENWOOD'
    });
  });

  it('has nothing to report on Android', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'android');
    await expect(getAudioDeviceStatus()).resolves.toBeNull();
    const listener = jest.fn();
    addAudioDeviceChangeListener(listener)();
    expect(listener).not.toHaveBeenCalled();
    os.restore();
  });

  it('delivers route changes, parsed, until unsubscribed', () => {
    const listener = jest.fn();
    const unsubscribe = addAudioDeviceChangeListener(listener);
    expect(SWAudioRoutes.addListener).toHaveBeenCalledWith('onAudioDeviceChanged');

    DeviceEventEmitter.emit('onAudioDeviceChanged', {
      availableAudioDeviceList: '["EARPIECE","SPEAKER_PHONE"]',
      selectedAudioDevice: 'EARPIECE',
      selectedAudioDeviceName: 'Receiver'
    });
    expect(listener).toHaveBeenCalledWith({
      available: ['EARPIECE', 'SPEAKER_PHONE'],
      selected: 'EARPIECE',
      selectedName: 'Receiver'
    });

    unsubscribe();
    DeviceEventEmitter.emit('onAudioDeviceChanged', {});
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
