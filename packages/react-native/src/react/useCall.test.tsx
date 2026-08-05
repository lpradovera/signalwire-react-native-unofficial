import { act, render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';
import { BehaviorSubject, Subject } from 'rxjs';

import { useCall } from './useCall';

function createFakeCall() {
  const status$ = new BehaviorSubject('ringing');
  const participants$ = new BehaviorSubject<unknown[]>([]);
  const self$ = new BehaviorSubject<unknown>(null);
  const localStream$ = new BehaviorSubject<unknown>(null);
  const remoteStream$ = new BehaviorSubject<unknown>(null);
  const errors$ = new Subject<{
    kind: string;
    fatal: boolean;
    error: Error;
    callId: string;
  }>();
  const audioMuted$ = new BehaviorSubject<boolean | undefined>(false);
  const videoMuted$ = new BehaviorSubject<boolean | undefined>(false);

  const self = {
    mute: jest.fn(async () => undefined),
    unmute: jest.fn(async () => undefined),
    muteVideo: jest.fn(async () => undefined),
    unmuteVideo: jest.fn(async () => undefined),
    audioMuted$,
    videoMuted$,
    audioMuted: false,
    videoMuted: false
  };
  self$.next(self);

  return {
    id: 'call-1',
    status$,
    get status() {
      return status$.value;
    },
    participants$,
    get participants() {
      return participants$.value;
    },
    self$,
    get self() {
      return self$.value;
    },
    localStream$,
    localStream: null,
    remoteStream$,
    remoteStream: null,
    errors$,
    hangup: jest.fn(async () => undefined),
    toggleHold: jest.fn(async () => undefined),
    sendDigits: jest.fn(async () => undefined),
    _self: self,
    _status$: status$,
    _participants$: participants$,
    _errors$: errors$
  };
}

type FakeCall = ReturnType<typeof createFakeCall>;

let result: ReturnType<typeof useCall> | undefined;

function Probe({ call }: { call: FakeCall | null }): React.JSX.Element {
  result = useCall(call as never);
  return <Text testID="status">{result.status}</Text>;
}

describe('useCall', () => {
  it('seeds status from the synchronous getter', () => {
    const { getByTestId } = render(<Probe call={createFakeCall()} />);
    expect(getByTestId('status').props.children).toBe('ringing');
  });

  it('tracks status changes', () => {
    const call = createFakeCall();
    const { getByTestId } = render(<Probe call={call} />);
    act(() => call._status$.next('connected'));
    expect(getByTestId('status').props.children).toBe('connected');
  });

  it('tracks participants', () => {
    const call = createFakeCall();
    render(<Probe call={call} />);
    act(() => call._participants$.next([{ id: 'p1' }]));
    expect(result?.participants).toEqual([{ id: 'p1' }]);
  });

  it('returns safe defaults for a null call', () => {
    render(<Probe call={null} />);
    expect(result?.status).toBe('new');
    expect(result?.participants).toEqual([]);
    expect(result?.localStream).toBeNull();
    expect(result?.remoteStream).toBeNull();
    expect(result?.error).toBeNull();
  });

  it('hangup delegates to the call', async () => {
    const call = createFakeCall();
    render(<Probe call={call} />);
    await act(async () => {
      await result?.hangup();
    });
    expect(call.hangup).toHaveBeenCalled();
  });

  it('hangup on a null call resolves without throwing', async () => {
    render(<Probe call={null} />);
    await expect(result?.hangup()).resolves.toBeUndefined();
  });

  it('setAudioMuted(true) mutes the self participant', async () => {
    const call = createFakeCall();
    render(<Probe call={call} />);
    await act(async () => {
      await result?.setAudioMuted(true);
    });
    expect(call._self.mute).toHaveBeenCalled();
  });

  it('setAudioMuted(false) unmutes the self participant', async () => {
    const call = createFakeCall();
    render(<Probe call={call} />);
    await act(async () => {
      await result?.setAudioMuted(false);
    });
    expect(call._self.unmute).toHaveBeenCalled();
  });

  it('setVideoMuted routes to the video methods', async () => {
    const call = createFakeCall();
    render(<Probe call={call} />);
    await act(async () => {
      await result?.setVideoMuted(true);
    });
    expect(call._self.muteVideo).toHaveBeenCalled();
  });

  it('coalesces an undefined audioMuted emission to false', () => {
    const call = createFakeCall();
    render(<Probe call={call} />);
    act(() => call._self.audioMuted$.next(undefined));
    expect(result?.isAudioMuted).toBe(false);
  });

  it('sendDigits delegates to the call', async () => {
    const call = createFakeCall();
    render(<Probe call={call} />);
    await act(async () => {
      await result?.sendDigits('123');
    });
    expect(call.sendDigits).toHaveBeenCalledWith('123');
  });

  it('exposes the most recent call error as the SDK structured shape', () => {
    const call = createFakeCall();
    render(<Probe call={call} />);
    act(() =>
      call._errors$.next({
        kind: 'media',
        fatal: true,
        error: new Error('media failed'),
        callId: 'call-1'
      })
    );
    expect(result?.error?.kind).toBe('media');
    expect(result?.error?.fatal).toBe(true);
    expect(result?.error?.error.message).toBe('media failed');
  });

  it('swaps subscriptions when the call changes', () => {
    const first = createFakeCall();
    const second = createFakeCall();
    second._status$.next('connected');

    const { getByTestId, rerender } = render(<Probe call={first} />);
    expect(getByTestId('status').props.children).toBe('ringing');

    rerender(<Probe call={second} />);
    expect(getByTestId('status').props.children).toBe('connected');
    expect(first._status$.observed).toBe(false);
  });
});
