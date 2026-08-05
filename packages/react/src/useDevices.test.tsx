import { act, render } from '@testing-library/react';
import React from 'react';
import { BehaviorSubject } from 'rxjs';

import { SignalWireContext } from './SignalWireProvider';
import { useDevices } from './useDevices';

const audioInputDevices$ = new BehaviorSubject<unknown[]>([]);
const videoInputDevices$ = new BehaviorSubject<unknown[]>([]);
const selectedAudioInputDevice$ = new BehaviorSubject<unknown>(null);
const selectedVideoInputDevice$ = new BehaviorSubject<unknown>(null);

const selectAudioInputDevice = jest.fn();
const selectVideoInputDevice = jest.fn();
const enumerateDevices = jest.fn(async () => undefined);

const client = {
  audioInputDevices$,
  audioInputDevices: [],
  videoInputDevices$,
  videoInputDevices: [],
  selectedAudioInputDevice$,
  selectedAudioInputDevice: null,
  selectedVideoInputDevice$,
  selectedVideoInputDevice: null,
  selectAudioInputDevice,
  selectVideoInputDevice,
  enumerateDevices
};

let result: ReturnType<typeof useDevices> | undefined;

function Probe(): React.JSX.Element {
  result = useDevices();
  return <span data-testid="count">{String(result.audioInputs.length)}</span>;
}

function renderWithClient(value: unknown = client): ReturnType<typeof render> {
  return render(
    <SignalWireContext.Provider
      value={{ client: value as never, error: null, observer: undefined }}
    >
      <Probe />
    </SignalWireContext.Provider>
  );
}

describe('useDevices', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    audioInputDevices$.next([]);
    videoInputDevices$.next([]);
    selectedAudioInputDevice$.next(null);
  });

  it('tracks the audio input list', () => {
    const { getByTestId } = renderWithClient();
    act(() => audioInputDevices$.next([{ deviceId: 'mic-1' }, { deviceId: 'mic-2' }]));
    expect(getByTestId('count').textContent).toBe('2');
  });

  it('tracks the video input list', () => {
    renderWithClient();
    act(() => videoInputDevices$.next([{ deviceId: 'cam-1' }]));
    expect(result?.videoInputs).toEqual([{ deviceId: 'cam-1' }]);
  });

  it('tracks the selected audio input', () => {
    renderWithClient();
    act(() => selectedAudioInputDevice$.next({ deviceId: 'mic-2' }));
    expect(result?.selectedAudioInput).toEqual({ deviceId: 'mic-2' });
  });

  it('selectAudioInput delegates to the client', () => {
    renderWithClient();
    const device = { deviceId: 'mic-2' };
    act(() => result?.selectAudioInput(device as never));
    expect(selectAudioInputDevice).toHaveBeenCalledWith(device);
  });

  it('selectVideoInput delegates to the client', () => {
    renderWithClient();
    const device = { deviceId: 'cam-2' };
    act(() => result?.selectVideoInput(device as never));
    expect(selectVideoInputDevice).toHaveBeenCalledWith(device);
  });

  it('refresh calls enumerateDevices because RN emits no devicechange', async () => {
    renderWithClient();
    await act(async () => {
      await result?.refresh();
    });
    expect(enumerateDevices).toHaveBeenCalledTimes(1);
  });

  it('returns empty lists and no-op actions when the client is null', async () => {
    renderWithClient(null);
    expect(result?.audioInputs).toEqual([]);
    expect(result?.videoInputs).toEqual([]);
    expect(() => result?.selectAudioInput(null)).not.toThrow();
    await expect(result?.refresh()).resolves.toBeUndefined();
  });

  it('does not expose audio outputs, which RN cannot select', () => {
    renderWithClient();
    expect((result as unknown as Record<string, unknown>).audioOutputs).toBeUndefined();
  });
});
