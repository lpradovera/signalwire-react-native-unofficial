import { DeviceEventEmitter, NativeModules } from 'react-native';

/**
 * incall-manager's iOS native module as the upstream iOS routes (or the patch
 * in docs/patches) add it: `getAudioDeviceStatus` and the
 * `onAudioDeviceChanged` event. Released incall-manager (through 4.3.0) has
 * neither on iOS, which is what the tests see unless they install this.
 */
export function deviceStatus(
  selected: string,
  available = '["EARPIECE","SPEAKER_PHONE","BLUETOOTH"]',
  name = selected
): Record<string, string> {
  return { availableAudioDeviceList: available, selectedAudioDevice: selected, selectedAudioDeviceName: name };
}

export const incallIosRoutes = {
  getAudioDeviceStatus: jest.fn(async () => deviceStatus('EARPIECE')),
  addListener: jest.fn(),
  removeListeners: jest.fn()
};

const modules = NativeModules as Record<string, unknown>;

/** Links incall-manager's iOS routes into NativeModules for this test. */
export function installIncallIosRoutes(current = deviceStatus('EARPIECE')): void {
  incallIosRoutes.getAudioDeviceStatus.mockImplementation(async () => current);
  modules.InCallManager = incallIosRoutes;
}

export function uninstallIncallIosRoutes(): void {
  delete modules.InCallManager;
}

/** What incall-manager reports after a route change: the system picker, a car connecting, ... */
export function reportDevice(selected: string, available?: string, name?: string): void {
  DeviceEventEmitter.emit('onAudioDeviceChanged', deviceStatus(selected, available, name));
}
