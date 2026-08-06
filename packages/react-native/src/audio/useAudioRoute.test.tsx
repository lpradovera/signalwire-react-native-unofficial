import { act, render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

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

  it('setRoute drives the controller', async () => {
    await render(<Probe />);
    await act(async () => result?.setRoute('bluetooth'));
    expect(getAudioRouteController().route).toBe('bluetooth');
  });
});
