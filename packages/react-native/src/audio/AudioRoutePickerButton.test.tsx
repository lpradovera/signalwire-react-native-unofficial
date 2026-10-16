import { render } from '@testing-library/react-native';
import React from 'react';
import { Platform, UIManager } from 'react-native';

import { installIncallIosRoutes, uninstallIncallIosRoutes } from '../../jest/mocks/incallIosRoutes';
import {
  AudioRoutePickerButton,
  isAudioRoutePickerAvailable,
  resetAudioRoutePickerForTesting
} from './AudioRoutePickerButton';

describe('AudioRoutePickerButton', () => {
  beforeEach(() => installIncallIosRoutes());

  afterEach(() => {
    jest.restoreAllMocks();
    uninstallIncallIosRoutes();
    resetAudioRoutePickerForTesting();
  });

  it('draws the native route picker on iOS', async () => {
    jest.spyOn(UIManager, 'hasViewManagerConfig').mockImplementation((name) => name === 'SWAudioRoutePicker');
    const { toJSON } = await render(<AudioRoutePickerButton testID="picker" tintColor="white" />);
    expect(isAudioRoutePickerAvailable()).toBe(true);
    expect(toJSON()).toMatchObject({
      type: 'SWAudioRoutePicker',
      props: { testID: 'picker', accessibilityLabel: 'Audio output' }
    });
  });

  it('draws nothing with released incall-manager, where nothing follows the picker’s choice', async () => {
    // incall-manager 4.3.0 neither reports a route the picker chose nor keeps
    // it: its next category-change re-apply can put the call back.
    uninstallIncallIosRoutes();
    jest.spyOn(UIManager, 'hasViewManagerConfig').mockImplementation((name) => name === 'SWAudioRoutePicker');
    const { toJSON } = await render(<AudioRoutePickerButton />);
    expect(isAudioRoutePickerAvailable()).toBe(false);
    expect(toJSON()).toBeNull();
  });

  it('draws nothing when the app was built without the native view', async () => {
    jest.spyOn(UIManager, 'hasViewManagerConfig').mockReturnValue(false);
    const { toJSON } = await render(<AudioRoutePickerButton />);
    expect(isAudioRoutePickerAvailable()).toBe(false);
    expect(toJSON()).toBeNull();
  });

  it('draws nothing on Android, even where a view manager by that name exists', async () => {
    // RN's jest UIManager mock knows no view managers, so without this the
    // test would pass with the iOS check deleted.
    jest.spyOn(UIManager, 'hasViewManagerConfig').mockReturnValue(true);
    const os = jest.replaceProperty(Platform, 'OS', 'android');
    const { toJSON } = await render(<AudioRoutePickerButton />);
    expect(isAudioRoutePickerAvailable()).toBe(false);
    expect(toJSON()).toBeNull();
    os.restore();
  });

  it('registers the native view once per process, not once per bundle copy', () => {
    resetAudioRoutePickerForTesting();
    // The audio entry ships as audio.mjs and audio.js; an app can load both.
    // A second requireNativeComponent of the same name throws "Tried to
    // register two views with the same name" during render.
    const registrations: string[] = [];
    const available: boolean[] = [];
    const loadAndCheck = (): void => {
      // Each copy is used inside its own registry: React Native exposes
      // UIManager through a lazy getter, so a spy taken here and a call made
      // after isolateModules returns would reach different UIManager mocks.
      jest.isolateModules(() => {
        const RN = require('react-native') as typeof import('react-native');
        jest.spyOn(RN.UIManager, 'hasViewManagerConfig').mockReturnValue(true);
        // This copy's incall-manager, with its iOS routes.
        (RN.NativeModules as Record<string, unknown>).InCallManager = { getAudioDeviceStatus: jest.fn() };
        const incall = (require('react-native-incall-manager') as { default: Record<string, unknown> }).default;
        Object.assign(incall, { getAudioDeviceStatus: jest.fn(), addListener: jest.fn() });
        jest.spyOn(RN, 'requireNativeComponent').mockImplementation(((name: string) => {
          registrations.push(name);
          return name;
        }) as never);
        const copy = require('./AudioRoutePickerButton') as typeof import('./AudioRoutePickerButton');
        available.push(copy.isAudioRoutePickerAvailable());
      });
    };

    loadAndCheck();
    loadAndCheck();

    expect(available).toEqual([true, true]);
    expect(registrations).toEqual(['SWAudioRoutePicker']);
  });
});
