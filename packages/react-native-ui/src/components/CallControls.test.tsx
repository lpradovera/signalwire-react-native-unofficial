import { act, fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';
import { BehaviorSubject, Subject } from 'rxjs';

jest.mock('@signalwire/react-native/audio', () => {
  // State lives inside the factory: a factory that closes over an outer const
  // reads it before the initialiser has run.
  const state = { route: 'earpiece', setRoute: jest.fn(), setSpeakerOn: jest.fn(), pickerAvailable: false };
  const { View } = jest.requireActual('react-native');
  return {
    useAudioRoute: () => state,
    // Like the real button: nothing unless iOS, the native view and incall-manager's iOS routes.
    AudioRoutePickerButton: (props: object) => (state.pickerAvailable ? <View {...props} /> : null),
    __state: state
  };
});

 
const audio = require('@signalwire/react-native/audio') as {
  __state: { route: string; setRoute: jest.Mock; setSpeakerOn: jest.Mock; pickerAvailable: boolean };
};

import { CallControls } from './CallControls';

/**
 * These drive the real `useCall`, with a fake call underneath. That is the
 * point: the controls must reflect SDK state rather than local state, so that
 * a mute performed from the CallKit UI or by the server shows up here.
 */
function createCall() {
  const audioMuted$ = new BehaviorSubject<boolean | undefined>(false);
  const videoMuted$ = new BehaviorSubject<boolean | undefined>(false);

  const self = {
    mute: jest.fn(async () => undefined),
    unmute: jest.fn(async () => undefined),
    muteVideo: jest.fn(async () => undefined),
    unmuteVideo: jest.fn(async () => undefined),
    audioMuted$,
    videoMuted$,
    get audioMuted() {
      return audioMuted$.value ?? false;
    },
    get videoMuted() {
      return videoMuted$.value ?? false;
    }
  };

  const self$ = new BehaviorSubject<unknown>(self);

  return {
    id: 'call-1',
    status$: new BehaviorSubject('connected'),
    status: 'connected',
    participants$: new BehaviorSubject([]),
    participants: [],
    self$,
    self,
    localStream$: new BehaviorSubject(null),
    localStream: null,
    remoteStream$: new BehaviorSubject(null),
    remoteStream: null,
    errors$: new Subject(),
    hangup: jest.fn(async () => undefined),
    toggleHold: jest.fn(async () => undefined),
    sendDigits: jest.fn(async () => undefined),
    _audioMuted$: audioMuted$
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  audio.__state.route = 'earpiece';
  audio.__state.pickerAvailable = false;
});

describe('CallControls', () => {
  it('shows Mute while unmuted and Unmute while muted', async () => {
    const call = createCall();
    await render(<CallControls call={call as never} />);
    expect(screen.getByTestId('sw-mute').props.accessibilityLabel).toBe('Mute');

    await act(async () => call._audioMuted$.next(true));
    expect(screen.getByTestId('sw-mute').props.accessibilityLabel).toBe('Unmute');
  });

  it('mutes through the SDK rather than local state', async () => {
    const call = createCall();
    await render(<CallControls call={call as never} />);

    await fireEvent.press(screen.getByTestId('sw-mute'));

    expect(call.self.mute).toHaveBeenCalled();
  });

  it('unmutes when already muted', async () => {
    const call = createCall();
    call._audioMuted$.next(true);
    await render(<CallControls call={call as never} />);

    await fireEvent.press(screen.getByTestId('sw-mute'));

    expect(call.self.unmute).toHaveBeenCalled();
  });

  it('reflects a mute that came from outside the component', async () => {
    const call = createCall();
    await render(<CallControls call={call as never} />);

    // e.g. the CallKit mute button, or a server-side mute.
    await act(async () => call._audioMuted$.next(true));

    expect(screen.getByTestId('sw-mute').props.accessibilityState.selected).toBe(true);
  });

  it('hangs up and notifies the caller', async () => {
    const call = createCall();
    const onHangup = jest.fn();
    await render(<CallControls call={call as never} onHangup={onHangup} />);

    await fireEvent.press(screen.getByTestId('sw-hangup'));
    await Promise.resolve();

    expect(call.hangup).toHaveBeenCalled();
  });

  it('toggles the speaker on', async () => {
    await render(<CallControls call={createCall() as never} />);
    await fireEvent.press(screen.getByTestId('sw-route'));
    expect(audio.__state.setSpeakerOn).toHaveBeenCalledWith(true);
  });

  it('toggles the speaker off without choosing the earpiece', async () => {
    // setRoute('earpiece') pins the call to the receiver, pulling it off a car
    // or headset; off returns to the call's own route instead.
    audio.__state.route = 'speaker';
    await render(<CallControls call={createCall() as never} />);
    await fireEvent.press(screen.getByTestId('sw-route'));
    expect(audio.__state.setSpeakerOn).toHaveBeenCalledWith(false);
    expect(audio.__state.setRoute).not.toHaveBeenCalled();
  });

  it('names the route the call is on, Bluetooth included, and turns the speaker on from it', async () => {
    // With iOS routes the route follows a car or headset taking the call; it
    // read "Earpiece" while audio played in the car.
    audio.__state.route = 'bluetooth';
    await render(<CallControls call={createCall() as never} />);
    expect(screen.getByText('Bluetooth')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('sw-route'));
    expect(audio.__state.setSpeakerOn).toHaveBeenCalledWith(true);
  });

  it('names a wired or USB-C headset "Headset", not "Earpiece"', async () => {
    audio.__state.route = 'headset';
    await render(<CallControls call={createCall() as never} />);
    expect(screen.getByText('Headset')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('sw-route'));
    expect(audio.__state.setSpeakerOn).toHaveBeenCalledWith(true);
  });

  it('hides the camera toggle when asked', async () => {
    await render(<CallControls call={createCall() as never} showVideo={false} />);
    expect(screen.queryByTestId('sw-video')).toBeNull();
  });

  it('hides the route toggle when asked', async () => {
    await render(<CallControls call={createCall() as never} showAudioRoute={false} />);
    expect(screen.queryByTestId('sw-route')).toBeNull();
  });

  it('shows the system audio output button where it is available (iOS)', async () => {
    audio.__state.pickerAvailable = true;
    await render(<CallControls call={createCall() as never} />);
    expect(screen.getByTestId('sw-route-picker')).toBeTruthy();
    expect(screen.getByTestId('sw-route')).toBeTruthy();
  });

  it('styles the output button as a pill itself, with no wrapper', async () => {
    // On the New Architecture React Native's interop container paints the
    // background and corner radius and insets the native view by the padding.
    audio.__state.pickerAvailable = true;
    await render(<CallControls call={createCall() as never} />);
    const picker = screen.getByTestId('sw-route-picker');
    expect(StyleSheet.flatten(picker.props.style)).toMatchObject({
      backgroundColor: expect.any(String),
      borderRadius: expect.any(Number),
      padding: expect.any(Number)
    });
    // No host view between the button and the bar.
    let between = 0;
    let node = picker.parent;
    while (node && node.props.accessibilityRole !== 'toolbar') {
      if (typeof node.type === 'string') between += 1;
      node = node.parent;
    }
    expect(node).toBeTruthy();
    expect(between).toBe(0);
  });

  it('wraps onto a second row rather than pushing the end buttons off a narrow screen', async () => {
    // Five controls need ~410 pt at the default text size, more than a
    // 375-pt iPhone; React Native children don't shrink (flexShrink 0), so a
    // single row overflows and Yoga centres it past both edges.
    audio.__state.pickerAvailable = true;
    await render(<CallControls call={createCall() as never} testID="bar" />);
    expect(StyleSheet.flatten(screen.getByTestId('bar').props.style)).toMatchObject({
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'center',
      rowGap: expect.any(Number)
    });
  });

  it('leaves the output button out where it is not, or when asked', async () => {
    await render(<CallControls call={createCall() as never} />);
    expect(screen.queryByTestId('sw-route-picker')).toBeNull();

    audio.__state.pickerAvailable = true;
    await render(<CallControls call={createCall() as never} showRoutePicker={false} />);
    expect(screen.queryByTestId('sw-route-picker')).toBeNull();
  });

  it('leaves the output button out of an app that hid audio routing', async () => {
    // An app that manages routing itself passes showAudioRoute={false}; an
    // upgrade must not add an output switch behind its back.
    audio.__state.pickerAvailable = true;
    await render(<CallControls call={createCall() as never} showAudioRoute={false} />);
    expect(screen.queryByTestId('sw-route-picker')).toBeNull();

    await render(<CallControls call={createCall() as never} showAudioRoute={false} showRoutePicker />);
    expect(screen.getByTestId('sw-route-picker')).toBeTruthy();
  });

  it('renders with a null call without throwing', async () => {
    await expect(render(<CallControls call={null} />)).resolves.toBeDefined();
  });

  it('exposes every control to assistive technology', async () => {
    await render(<CallControls call={createCall() as never} />);
    for (const id of ['sw-mute', 'sw-video', 'sw-route', 'sw-hangup']) {
      const button = screen.getByTestId(id);
      expect(button.props.accessibilityRole).toBe('button');
      expect(button.props.accessibilityLabel).toEqual(expect.any(String));
    }
  });

  it('leaves the call screen even when hangup never settles', async () => {
    // A call whose media never arrived may leave the verto `bye` unanswered
    // forever, so even a `.finally()` would not run. Navigation must not wait.
    const call = createCall();
    call.hangup = jest.fn(() => new Promise<undefined>(() => undefined));
    const onHangup = jest.fn();
    await render(<CallControls call={call as never} onHangup={onHangup} />);

    await fireEvent.press(screen.getByTestId('sw-hangup'));

    expect(onHangup).toHaveBeenCalled();
  });

  it('leaves the call screen even when hangup rejects', async () => {
    // A call the far end never answered rejects here: the verto `bye` gets no
    // response and times out. Gating navigation on that stranded the user on
    // the call screen with no way back.
    const call = createCall();
    call.hangup = jest.fn(async () => {
      throw new Error('RPC timeout');
    });
    const onHangup = jest.fn();
    await render(<CallControls call={call as never} onHangup={onHangup} />);

    await fireEvent.press(screen.getByTestId('sw-hangup'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(onHangup).toHaveBeenCalled();
  });
});
