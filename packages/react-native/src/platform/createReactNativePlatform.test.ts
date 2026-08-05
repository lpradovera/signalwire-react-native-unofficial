jest.mock('./networkShim');
jest.mock('./visibilityShim');

import { createReactNativePlatform } from './createReactNativePlatform';
import { installNetworkShim } from './networkShim';
import { installVisibilityShim } from './visibilityShim';

const installNetwork = installNetworkShim as jest.MockedFunction<typeof installNetworkShim>;
const installVisibility = installVisibilityShim as jest.MockedFunction<
  typeof installVisibilityShim
>;

describe('createReactNativePlatform', () => {
  beforeEach(() => {
    installNetwork.mockReset();
    installVisibility.mockReset();
    installNetwork.mockReturnValue(jest.fn());
    installVisibility.mockReturnValue(jest.fn());
  });

  it('returns SignalWireOptions with a WebRTC provider and storage', () => {
    const platform = createReactNativePlatform();
    expect(platform.options.webRTCApiProvider).toBeDefined();
    expect(platform.options.storageImplementation).toBeDefined();
    platform.dispose();
  });

  it('sets skipDeviceMonitoring because RN emits no devicechange', () => {
    const platform = createReactNativePlatform();
    expect(platform.options.skipDeviceMonitoring).toBe(true);
    platform.dispose();
  });

  it('installs both shims by default', () => {
    const platform = createReactNativePlatform();
    expect(installNetwork).toHaveBeenCalledTimes(1);
    expect(installVisibility).toHaveBeenCalledTimes(1);
    platform.dispose();
  });

  it('skips the network shim when netInfo is false', () => {
    const platform = createReactNativePlatform({ netInfo: false });
    expect(installNetwork).not.toHaveBeenCalled();
    expect(installVisibility).toHaveBeenCalledTimes(1);
    platform.dispose();
  });

  it('skips the visibility shim when appState is false', () => {
    const platform = createReactNativePlatform({ appState: false });
    expect(installVisibility).not.toHaveBeenCalled();
    platform.dispose();
  });

  it('dispose uninstalls every shim it installed', () => {
    const stopNetwork = jest.fn();
    const stopVisibility = jest.fn();
    installNetwork.mockReturnValueOnce(stopNetwork);
    installVisibility.mockReturnValueOnce(stopVisibility);

    createReactNativePlatform().dispose();

    expect(stopNetwork).toHaveBeenCalledTimes(1);
    expect(stopVisibility).toHaveBeenCalledTimes(1);
  });

  it('dispose is safe to call twice', () => {
    const stopNetwork = jest.fn();
    installNetwork.mockReturnValueOnce(stopNetwork);
    const platform = createReactNativePlatform();
    platform.dispose();
    platform.dispose();
    expect(stopNetwork).toHaveBeenCalledTimes(1);
  });

  it('continues without the network shim when NetInfo is not installed', () => {
    installNetwork.mockImplementationOnce(() => {
      throw new Error('missing peer');
    });
    const platform = createReactNativePlatform();
    expect(platform.options.webRTCApiProvider).toBeDefined();
    platform.dispose();
  });

  it('honours caller-supplied storage and WebRTC provider overrides', () => {
    const storage = {
      setItem: jest.fn(),
      getItem: jest.fn(),
      removeItem: jest.fn(),
      clear: jest.fn()
    };
    const webRTCApiProvider = { RTCPeerConnection: class {}, mediaDevices: {} };
    const platform = createReactNativePlatform({
      storage: storage as never,
      webRTCApiProvider: webRTCApiProvider as never
    });
    expect(platform.options.storageImplementation).toBe(storage);
    expect(platform.options.webRTCApiProvider).toBe(webRTCApiProvider);
    platform.dispose();
  });
});
