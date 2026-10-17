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

  it('is a button to VoiceOver: the interop container is the element, and it takes its traits from accessibilityRole', async () => {
    // Under the New Architecture the picker sits in React Native's interop
    // container, which becomes the accessibility element and reads its traits
    // from the role prop, not from the native view's override.
    jest.spyOn(UIManager, 'hasViewManagerConfig').mockImplementation((name) => name === 'SWAudioRoutePicker');
    const { toJSON } = await render(<AudioRoutePickerButton />);
    expect(toJSON()).toMatchObject({ props: { accessibilityRole: 'button' } });
    const { toJSON: own } = await render(<AudioRoutePickerButton accessibilityRole="none" />);
    expect(own()).toMatchObject({ props: { accessibilityRole: 'none' } });
  });

  it('maps aria-* and id the way View does, since it renders the native host directly', async () => {
    jest.spyOn(UIManager, 'hasViewManagerConfig').mockImplementation((name) => name === 'SWAudioRoutePicker');
    const { toJSON } = await render(
      <AudioRoutePickerButton
        aria-label="Sortie audio"
        aria-hidden
        aria-disabled
        id="route"
        accessibilityLabel="ignored: aria-label wins, as on View"
      />
    );
    const tree = toJSON() as { props: Record<string, unknown> };
    expect(tree.props).toMatchObject({
      accessibilityLabel: 'Sortie audio',
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
      accessibilityState: { disabled: true },
      nativeID: 'route'
    });
    expect(Object.keys(tree.props).filter((key) => key.startsWith('aria-') || key === 'id')).toEqual([]);
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
