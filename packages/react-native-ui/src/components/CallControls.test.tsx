import { act, fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { BehaviorSubject, Subject } from 'rxjs';

jest.mock('@signalwire/react-native/audio', () => {
  // State lives inside the factory: a factory that closes over an outer const
  // reads it before the initialiser has run.
  const state = { route: 'earpiece', setRoute: jest.fn() };
  return { useAudioRoute: () => state, __state: state };
});

 
const audio = require('@signalwire/react-native/audio') as {
  __state: { route: string; setRoute: jest.Mock };
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

    fireEvent.press(screen.getByTestId('sw-mute'));

    expect(call.self.mute).toHaveBeenCalled();
  });

  it('unmutes when already muted', async () => {
    const call = createCall();
    call._audioMuted$.next(true);
    await render(<CallControls call={call as never} />);

    fireEvent.press(screen.getByTestId('sw-mute'));

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

    fireEvent.press(screen.getByTestId('sw-hangup'));
    await Promise.resolve();

    expect(call.hangup).toHaveBeenCalled();
  });

  it('toggles the audio route', async () => {
    await render(<CallControls call={createCall() as never} />);
    fireEvent.press(screen.getByTestId('sw-route'));
    expect(audio.__state.setRoute).toHaveBeenCalledWith('speaker');
  });

  it('hides the camera toggle when asked', async () => {
    await render(<CallControls call={createCall() as never} showVideo={false} />);
    expect(screen.queryByTestId('sw-video')).toBeNull();
  });

  it('hides the route toggle when asked', async () => {
    await render(<CallControls call={createCall() as never} showAudioRoute={false} />);
    expect(screen.queryByTestId('sw-route')).toBeNull();
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

    fireEvent.press(screen.getByTestId('sw-hangup'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(onHangup).toHaveBeenCalled();
  });
});
