type NetInfoListener = (state: { isConnected: boolean | null }) => void;

const mockListeners: NetInfoListener[] = [];
const mockUnsubscribe = jest.fn();

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    addEventListener: (listener: NetInfoListener) => {
      mockListeners.push(listener);
      return mockUnsubscribe;
    }
  }
}));

import { installNetworkShim } from './networkShim';

type Windowish = { addEventListener: (t: string, l: () => void) => void };

function win(): Windowish {
  return (globalThis as unknown as { window: Windowish }).window;
}

function nav(): { onLine: boolean } {
  return (globalThis as unknown as { navigator: { onLine: boolean } }).navigator;
}

describe('installNetworkShim', () => {
  let uninstall: (() => void) | undefined;

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    mockListeners.length = 0;
    mockUnsubscribe.mockClear();
  });

  it('creates window.addEventListener when absent', () => {
    uninstall = installNetworkShim();
    expect(typeof win().addEventListener).toBe('function');
  });

  it('dispatches offline then online as NetInfo reports connectivity changes', () => {
    uninstall = installNetworkShim();

    const onOffline = jest.fn();
    const onOnline = jest.fn();
    win().addEventListener('offline', onOffline);
    win().addEventListener('online', onOnline);

    mockListeners[0]?.({ isConnected: false });
    expect(onOffline).toHaveBeenCalledTimes(1);
    expect(onOnline).not.toHaveBeenCalled();

    mockListeners[0]?.({ isConnected: true });
    expect(onOnline).toHaveBeenCalledTimes(1);
  });

  it('does not re-dispatch when connectivity is unchanged', () => {
    uninstall = installNetworkShim();
    const onOffline = jest.fn();
    win().addEventListener('offline', onOffline);

    mockListeners[0]?.({ isConnected: false });
    mockListeners[0]?.({ isConnected: false });

    expect(onOffline).toHaveBeenCalledTimes(1);
  });

  it('keeps navigator.onLine in sync for the SDK initial read', () => {
    uninstall = installNetworkShim();
    mockListeners[0]?.({ isConnected: false });
    expect(nav().onLine).toBe(false);
    mockListeners[0]?.({ isConnected: true });
    expect(nav().onLine).toBe(true);
  });

  it('is idempotent and subscribes to NetInfo only once', () => {
    uninstall = installNetworkShim();
    const second = installNetworkShim();
    expect(mockListeners).toHaveLength(1);
    second();
  });

  it('unsubscribes from NetInfo on uninstall', () => {
    const stop = installNetworkShim();
    stop();
    expect(mockUnsubscribe).toHaveBeenCalled();
  });

  it('treats a null isConnected as offline', () => {
    uninstall = installNetworkShim();
    const onOffline = jest.fn();
    win().addEventListener('offline', onOffline);
    mockListeners[0]?.({ isConnected: null });
    expect(onOffline).toHaveBeenCalledTimes(1);
  });
});
