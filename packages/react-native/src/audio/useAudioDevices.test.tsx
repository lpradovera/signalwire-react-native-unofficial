import { act, render } from '@testing-library/react-native';
import React from 'react';
import { DeviceEventEmitter, Text } from 'react-native';

import { useAudioDevices } from './useAudioDevices';

function Probe(): React.JSX.Element {
  const { selected, selectedName, available } = useAudioDevices();
  return <Text testID="devices">{`${selected ?? '-'} ${selectedName} ${available.join(',')}`}</Text>;
}

describe('useAudioDevices', () => {
  it('reports the current devices, then follows route changes', async () => {
    const { getByTestId } = await render(<Probe />);
    expect(getByTestId('devices').props.children).toBe('BLUETOOTH KENWOOD EARPIECE,SPEAKER_PHONE,BLUETOOTH');

    await act(async () =>
      DeviceEventEmitter.emit('onAudioDeviceChanged', {
        availableAudioDeviceList: '["EARPIECE","SPEAKER_PHONE"]',
        selectedAudioDevice: 'EARPIECE',
        selectedAudioDeviceName: 'Receiver'
      })
    );
    expect(getByTestId('devices').props.children).toBe('EARPIECE Receiver EARPIECE,SPEAKER_PHONE');
  });
});
