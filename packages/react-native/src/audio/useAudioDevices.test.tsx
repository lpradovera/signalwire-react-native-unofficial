import { act, render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import {
  deviceStatus,
  incallIosRoutes,
  installIncallIosRoutes,
  reportDevice,
  uninstallIncallIosRoutes
} from '../../jest/mocks/incallIosRoutes';
import InCallManager from 'react-native-incall-manager';

import { resetAudioDevicesForTesting } from './nativeAudioRoutes';
import { useAudioDevices } from './useAudioDevices';

const wrapper = InCallManager as unknown as { addListener: jest.Mock };

function Probe({ id }: { id: string }): React.JSX.Element {
  const { selected, selectedName, available } = useAudioDevices();
  return <Text testID={id}>{`${selected ?? '-'} ${selectedName} ${available.join(',')}`}</Text>;
}

afterEach(() => {
  resetAudioDevicesForTesting();
  uninstallIncallIosRoutes();
  jest.clearAllMocks();
});

describe('useAudioDevices', () => {
  it('reports the current devices, then follows route changes', async () => {
    installIncallIosRoutes(deviceStatus('BLUETOOTH', undefined, 'KENWOOD'));
    const { getByTestId } = await render(<Probe id="devices" />);
    await act(async () => undefined);
    expect(getByTestId('devices').props.children).toBe('BLUETOOTH KENWOOD EARPIECE,SPEAKER_PHONE,BLUETOOTH');

    await act(async () => reportDevice('EARPIECE', '["EARPIECE","SPEAKER_PHONE"]', 'Receiver'));
    expect(getByTestId('devices').props.children).toBe('EARPIECE Receiver EARPIECE,SPEAKER_PHONE');
  });

  it('takes its first read over a report that reached it before the read came back', async () => {
    // incall-manager answers the read on the queue it reports from, so the
    // report was sent before the read.
    let resolve: (status: unknown) => void = () => undefined;
    installIncallIosRoutes();
    incallIosRoutes.getAudioDeviceStatus.mockImplementation(() => new Promise((done) => (resolve = done)) as never);
    const { getByTestId } = await render(<Probe id="devices" />);

    await act(async () => reportDevice('EARPIECE', '["EARPIECE","SPEAKER_PHONE"]', 'Receiver'));
    await act(async () => resolve(deviceStatus('BLUETOOTH', undefined, 'KENWOOD')));

    expect(getByTestId('devices').props.children).toBe('BLUETOOTH KENWOOD EARPIECE,SPEAKER_PHONE,BLUETOOTH');
  });

  it('connects once per mount: one native subscription and one read', async () => {
    installIncallIosRoutes(deviceStatus('EARPIECE'));
    await render(<Probe id="devices" />);
    await act(async () => undefined);
    expect(wrapper.addListener).toHaveBeenCalledTimes(1);
    expect(incallIosRoutes.getAudioDeviceStatus).toHaveBeenCalledTimes(1);
  });

  it('lets go of the native subscription when the last hook unmounts, with no grace period', async () => {
    installIncallIosRoutes(deviceStatus('EARPIECE'));
    const { unmount } = await render(<Probe id="devices" />);
    await act(async () => undefined);
    const remove = jest.spyOn(wrapper.addListener.mock.results[0]!.value as { remove(): void }, 'remove');
    await act(async () => unmount());
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('gives every mounted hook the same status', async () => {
    installIncallIosRoutes(deviceStatus('EARPIECE'));
    const { getByTestId } = await render(
      <>
        <Probe id="a" />
        <Probe id="b" />
      </>
    );
    await act(async () => reportDevice('BLUETOOTH', undefined, 'KENWOOD'));
    // One native subscription and one read serve both.
    expect(wrapper.addListener).toHaveBeenCalledTimes(1);
    expect(incallIosRoutes.getAudioDeviceStatus).toHaveBeenCalledTimes(1);
    expect(getByTestId('a').props.children).toBe(getByTestId('b').props.children);
    expect(getByTestId('a').props.children).toBe('BLUETOOTH KENWOOD EARPIECE,SPEAKER_PHONE,BLUETOOTH');
  });

  it('stays empty without iOS routes', async () => {
    const { getByTestId } = await render(<Probe id="devices" />);
    expect(getByTestId('devices').props.children).toBe('-  ');
  });
});
