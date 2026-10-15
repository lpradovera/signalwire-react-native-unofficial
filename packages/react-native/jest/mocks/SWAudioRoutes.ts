/**
 * This package's own iOS route module (ios/SWAudioRoutes.m), as it appears in
 * NativeModules. Installed by jest/setup.ts; resolves the way the native side
 * does, with the status payload incall-manager's Android side also sends.
 */
export const status = {
  availableAudioDeviceList: '["EARPIECE","SPEAKER_PHONE","BLUETOOTH"]',
  selectedAudioDevice: 'BLUETOOTH',
  selectedAudioDeviceName: 'KENWOOD'
};

const SWAudioRoutes = {
  chooseAudioRoute: jest.fn(async () => status),
  getAudioDeviceStatus: jest.fn(async () => status),
  addListener: jest.fn(),
  removeListeners: jest.fn()
};

export default SWAudioRoutes;
