import { DeviceEventEmitter, NativeModules } from 'react-native';
import InCallManager from 'react-native-incall-manager';

/** A status payload as incall-manager sends it: the list arrives as a JSON string. */
export function deviceStatus(
  selected: string,
  available = '["EARPIECE","SPEAKER_PHONE","BLUETOOTH"]',
  name = selected
): Record<string, string> {
  return { availableAudioDeviceList: available, selectedAudioDevice: selected, selectedAudioDeviceName: name };
}

/**
 * incall-manager's iOS native module as the upstream iOS routes (or the patch
 * in docs/patches) add it: `getAudioDeviceStatus` (and `start`, which the
 * controller's linked check looks for). Released incall-manager (through
 * 4.3.0) has no `getAudioDeviceStatus` on iOS, which is what the tests see
 * unless they install this. Events go through the JS wrapper's
 * `addListener`, which the tests route to DeviceEventEmitter.
 */
export const incallIosRoutes = {
  start: jest.fn(),
  getAudioDeviceStatus: jest.fn(async () => deviceStatus('EARPIECE'))
};

const modules = NativeModules as Record<string, unknown>;
/** What the tests see of incall-manager's JS wrapper beyond the base mock. */
const wrapper = InCallManager as unknown as Record<string, unknown>;
const choose = InCallManager.chooseAudioRoute as jest.Mock;
const DEFAULT_LIST = '["EARPIECE","SPEAKER_PHONE","BLUETOOTH"]';
/** The device list incall-manager last sent, which a choice's answer carries too. */
let lastList = DEFAULT_LIST;

/**
 * Links incall-manager's iOS routes for this test: the native method and the
 * JS wrapper's `addListener` / `getAudioDeviceStatus`. `chooseAudioRoute`
 * answers like the real module: it sends the change, then resolves the
 * settled status.
 */
export function installIncallIosRoutes(current = deviceStatus('EARPIECE')): void {
  lastList = current.availableAudioDeviceList ?? DEFAULT_LIST;
  incallIosRoutes.getAudioDeviceStatus.mockImplementation(async () => current);
  modules.InCallManager = incallIosRoutes;
  wrapper.getAudioDeviceStatus = jest.fn(() => incallIosRoutes.getAudioDeviceStatus());
  wrapper.addListener = jest.fn((event: string, listener: (raw: unknown) => void) =>
    DeviceEventEmitter.addListener(event, listener)
  );
  choose.mockImplementation(async (route: string) => {
    const settled = deviceStatus(route, lastList);
    DeviceEventEmitter.emit('onAudioDeviceChanged', settled);
    return settled;
  });
}

/** Back to released incall-manager: a linked native module without iOS routes. */
export function uninstallIncallIosRoutes(): void {
  modules.InCallManager = { start: jest.fn() };
  delete wrapper.getAudioDeviceStatus;
  delete wrapper.addListener;
  choose.mockReset();
  choose.mockImplementation(async () => undefined);
}

/** What incall-manager reports after a route change: the system picker, a car connecting, ... */
export function reportDevice(selected: string, available?: string, name?: string): void {
  lastList = available ?? DEFAULT_LIST;
  DeviceEventEmitter.emit('onAudioDeviceChanged', deviceStatus(selected, available, name));
}
