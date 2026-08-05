type AppStateHandler = (state: string) => void;

const mockHandlers: AppStateHandler[] = [];
const mockRemove = jest.fn();

jest.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_type: string, handler: AppStateHandler) => {
      mockHandlers.push(handler);
      return { remove: mockRemove };
    }
  }
}));

import { installVisibilityShim } from './visibilityShim';

type Documentish = {
  visibilityState: string;
  addEventListener: (t: string, l: () => void) => void;
};

function doc(): Documentish {
  return (globalThis as unknown as { document: Documentish }).document;
}

describe('installVisibilityShim', () => {
  let uninstall: (() => void) | undefined;

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    mockHandlers.length = 0;
    mockRemove.mockClear();
  });

  it('creates document.visibilityState seeded from AppState', () => {
    uninstall = installVisibilityShim();
    expect(doc().visibilityState).toBe('visible');
  });

  it('maps background to hidden and fires visibilitychange', () => {
    uninstall = installVisibilityShim();

    const onChange = jest.fn();
    doc().addEventListener('visibilitychange', onChange);

    mockHandlers[0]?.('background');

    expect(doc().visibilityState).toBe('hidden');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('maps inactive to hidden, which covers the iOS call-banner state', () => {
    uninstall = installVisibilityShim();
    mockHandlers[0]?.('inactive');
    expect(doc().visibilityState).toBe('hidden');
  });

  it('returns to visible on active', () => {
    uninstall = installVisibilityShim();
    mockHandlers[0]?.('background');
    mockHandlers[0]?.('active');
    expect(doc().visibilityState).toBe('visible');
  });

  it('does not fire when the mapped state is unchanged', () => {
    uninstall = installVisibilityShim();
    const onChange = jest.fn();
    doc().addEventListener('visibilitychange', onChange);

    mockHandlers[0]?.('background');
    mockHandlers[0]?.('inactive');

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('is idempotent and subscribes to AppState only once', () => {
    uninstall = installVisibilityShim();
    const second = installVisibilityShim();
    expect(mockHandlers).toHaveLength(1);
    second();
  });

  it('removes the AppState subscription on uninstall', () => {
    const stop = installVisibilityShim();
    stop();
    expect(mockRemove).toHaveBeenCalled();
  });
});
