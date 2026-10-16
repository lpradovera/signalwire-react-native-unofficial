import { act, render } from '@testing-library/react-native';
import React from 'react';
import { NativeModules, Text } from 'react-native';

import { logger } from '@signalwire/react';
import { MissingPeerDependencyError } from '../errors';

import {
  getAudioRouteController,
  resetAudioRouteControllerForTesting
} from './AudioRouteController';
import { useAudioRoute } from './useAudioRoute';

let result: ReturnType<typeof useAudioRoute> | undefined;

function Probe(): React.JSX.Element {
  result = useAudioRoute();
  return <Text testID="route">{result.route}</Text>;
}

describe('useAudioRoute', () => {
  afterEach(() => resetAudioRouteControllerForTesting());

  it('reports the controller current route', async () => {
    const { getByTestId } = await render(<Probe />);
    expect(getByTestId('route').props.children).toBe('earpiece');
  });

  it('re-renders when the controller route changes', async () => {
    const { getByTestId } = await render(<Probe />);
    await act(async () => getAudioRouteController().setRoute('speaker'));
    expect(getByTestId('route').props.children).toBe('speaker');
  });

  it('renders instead of throwing when incall-manager is installed but not linked', async () => {
    // CallControls calls this hook even with the speaker button hidden; an
    // app built before incall-manager was added must still get its controls.
    const modules = NativeModules as Record<string, unknown>;
    const linked = modules.InCallManager;
    delete modules.InCallManager;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const { getByTestId } = await render(<Probe />);
      expect(getByTestId('route').props.children).toBe('earpiece');
      expect(() => result?.setSpeakerOn(true)).not.toThrow();
      expect(() => result?.setRoute('speaker')).not.toThrow();
      expect(warn).toHaveBeenCalledWith('Audio routing unavailable:', expect.any(MissingPeerDependencyError));
    } finally {
      modules.InCallManager = linked;
      warn.mockRestore();
    }
  });

  it('setRoute drives the controller', async () => {
    await render(<Probe />);
    await act(async () => result?.setRoute('speaker'));
    expect(getAudioRouteController().route).toBe('speaker');
  });
});
