/**
 * CallControls' End, Mute and Camera against the call states the SDK goes
 * through, and what each control says to VoiceOver/TalkBack. A separate file
 * from CallControls.test.tsx, which the audio-route branches rewrite.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { BehaviorSubject, Subject } from 'rxjs';

import { logger } from '@signalwire/react';

jest.mock('@signalwire/react-native/audio', () => {
  const state = { route: 'earpiece', setRoute: jest.fn(), setSpeakerOn: jest.fn() };
  // AudioRoutePickerButton: the iOS output button feat/ios-audio-routes-native
  // adds to the bar; it renders nothing here, like the real one off iOS.
  return { useAudioRoute: () => state, AudioRoutePickerButton: () => null, __state: state };
});

const audio = require('@signalwire/react-native/audio') as {
  __state: { route: string; setRoute: jest.Mock };
};

import { CallControls } from './CallControls';

function createCall({ withSelf = true }: { withSelf?: boolean } = {}) {
  const audioMuted$ = new BehaviorSubject<boolean | undefined>(false);
  const videoMuted$ = new BehaviorSubject<boolean | undefined>(false);
  const self = {
    id: 'me',
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
  const self$ = new BehaviorSubject<unknown>(withSelf ? self : null);
  const call = {
    id: 'call-1',
    status$: new BehaviorSubject('connected'),
    status: 'connected',
    participants$: new BehaviorSubject([]),
    participants: [],
    self$,
    get self() {
      return self$.value;
    },
    localStream$: new BehaviorSubject(null),
    localStream: null,
    remoteStream$: new BehaviorSubject(null),
    remoteStream: null,
    errors$: new Subject(),
    hangup: jest.fn(async () => undefined),
    toggleHold: jest.fn(async () => undefined),
    sendDigits: jest.fn(async () => undefined),
    _self: self,
    _audioMuted$: audioMuted$,
    _videoMuted$: videoMuted$
  };
  return call;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  audio.__state.route = 'earpiece';
});

describe('CallControls: End', () => {
  it('runs onHangup and hangup once, however often End is pressed', async () => {
    const call = createCall();
    const onHangup = jest.fn();
    await render(<CallControls call={call as never} onHangup={onHangup} />);

    await fireEvent.press(screen.getByTestId('sw-hangup'));
    await fireEvent.press(screen.getByTestId('sw-hangup'));
    await flush();

    expect(onHangup).toHaveBeenCalledTimes(1);
    expect(call.hangup).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('sw-hangup').props.accessibilityState.disabled).toBe(true);
  });

  it('is pressable again for the next call', async () => {
    const first = createCall();
    const onHangup = jest.fn();
    const { rerender } = await render(<CallControls call={first as never} onHangup={onHangup} />);
    await fireEvent.press(screen.getByTestId('sw-hangup'));
    await flush();

    const second = createCall();
    await rerender(<CallControls call={second as never} onHangup={onHangup} />);
    await fireEvent.press(screen.getByTestId('sw-hangup'));
    await flush();

    expect(second.hangup).toHaveBeenCalledTimes(1);
    expect(onHangup).toHaveBeenCalledTimes(2);
  });
});

describe('CallControls: Mute and Camera', () => {
  it('are disabled until the call has a self participant', async () => {
    const call = createCall({ withSelf: false });
    await render(<CallControls call={call as never} />);
    expect(screen.getByTestId('sw-mute').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('sw-video').props.accessibilityState.disabled).toBe(true);

    await act(async () => call.self$.next(call._self));
    expect(screen.getByTestId('sw-mute').props.accessibilityState.disabled).toBe(false);
    expect(screen.getByTestId('sw-video').props.accessibilityState.disabled).toBe(false);
  });

  it('logs a mute that fails instead of leaving the rejection unhandled', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const call = createCall();
    call._self.mute = jest.fn(async () => {
      throw new Error('DependencyError: no peer connection');
    });
    call._self.muteVideo = jest.fn(async () => {
      throw new Error('DependencyError: no peer connection');
    });
    await render(<CallControls call={call as never} />);

    await fireEvent.press(screen.getByTestId('sw-mute'));
    await fireEvent.press(screen.getByTestId('sw-video'));
    await flush();

    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('CallControls: what assistive technology hears', () => {
  it('names each toggle once and carries its state in selected', async () => {
    const call = createCall();
    await render(<CallControls call={call as never} />);
    const mute = () => screen.getByTestId('sw-mute');
    const video = () => screen.getByTestId('sw-video');

    expect(mute().props.accessibilityLabel).toBe('Mute');
    expect(mute().props.accessibilityState.selected).toBe(false);
    expect(video().props.accessibilityLabel).toBe('Camera off');
    expect(video().props.accessibilityState.selected).toBe(false);

    await act(async () => {
      call._audioMuted$.next(true);
      call._videoMuted$.next(true);
    });

    // The visible text says what a tap does; the accessible name stays put
    // and `selected` says the toggle is on, so the state is spoken once.
    expect(screen.getByText('Unmute')).toBeTruthy();
    expect(mute().props.accessibilityLabel).toBe('Mute');
    expect(mute().props.accessibilityState.selected).toBe(true);
    expect(screen.getByText('Camera on')).toBeTruthy();
    expect(video().props.accessibilityLabel).toBe('Camera off');
    expect(video().props.accessibilityState.selected).toBe(true);
  });

  it('names the speaker toggle for what it does, not for the current route', async () => {
    await render(<CallControls call={createCall() as never} />);
    const route = screen.getByTestId('sw-route');
    expect(screen.getByText('Earpiece')).toBeTruthy();
    expect(route.props.accessibilityLabel).toBe('Speaker');
    expect(route.props.accessibilityState.selected).toBe(false);
  });

  it('marks the speaker toggle selected while the call is on the speaker', async () => {
    audio.__state.route = 'speaker';
    await render(<CallControls call={createCall() as never} />);
    const route = screen.getByTestId('sw-route');
    expect(route.props.accessibilityLabel).toBe('Speaker');
    expect(route.props.accessibilityState.selected).toBe(true);
  });
});
