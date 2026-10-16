jest.mock('./networkShim');
jest.mock('./visibilityShim');

import { AppState } from 'react-native';

import { createReactNativePlatform } from './createReactNativePlatform';
import { installNetworkShim } from './networkShim';
import { installVisibilityShim } from './visibilityShim';

import type { AppStateStatus } from 'react-native';

describe('createReactNativePlatform watchForeground', () => {
  let handlers: Array<(state: AppStateStatus) => void>;
  let remove: jest.Mock;

  beforeEach(() => {
    (installNetworkShim as jest.Mock).mockReturnValue(jest.fn());
    (installVisibilityShim as jest.Mock).mockReturnValue(jest.fn());
    handlers = [];
    remove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      handlers.push(handler as (state: AppStateStatus) => void);
      return { remove } as never;
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('calls the listener when the app becomes active, not when it leaves', () => {
    const platform = createReactNativePlatform();
    const listener = jest.fn();
    const stop = platform.watchForeground?.(listener);

    handlers.forEach((handler) => handler('background'));
    expect(listener).not.toHaveBeenCalled();
    handlers.forEach((handler) => handler('active'));
    expect(listener).toHaveBeenCalledTimes(1);

    stop?.();
    expect(remove).toHaveBeenCalled();
    platform.dispose();
  });
});
