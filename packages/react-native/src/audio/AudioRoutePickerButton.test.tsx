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

  it('draws nothing on Android', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'android');
    const { toJSON } = await render(<AudioRoutePickerButton />);
    expect(toJSON()).toBeNull();
    os.restore();
  });
});
