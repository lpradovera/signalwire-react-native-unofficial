import { render } from '@testing-library/react-native';
import React from 'react';
import { Platform, UIManager } from 'react-native';

import {
  AudioRoutePickerButton,
  isAudioRoutePickerAvailable,
  resetAudioRoutePickerForTesting
} from './AudioRoutePickerButton';

describe('AudioRoutePickerButton', () => {
  afterEach(() => {
    jest.restoreAllMocks();
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
    const load = (): typeof import('./AudioRoutePickerButton') => {
      let copy: typeof import('./AudioRoutePickerButton') | undefined;
      jest.isolateModules(() => {
        const RN = require('react-native') as typeof import('react-native');
        jest.spyOn(RN.UIManager, 'hasViewManagerConfig').mockReturnValue(true);
        jest.spyOn(RN, 'requireNativeComponent').mockImplementation(((name: string) => {
          registrations.push(name);
          return name;
        }) as never);
        copy = require('./AudioRoutePickerButton') as typeof import('./AudioRoutePickerButton');
      });
      return copy!;
    };

    expect(load().isAudioRoutePickerAvailable()).toBe(true);
    expect(load().isAudioRoutePickerAvailable()).toBe(true);
    expect(registrations).toEqual(['SWAudioRoutePicker']);
  });
});
