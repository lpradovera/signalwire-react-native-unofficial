import { render } from '@testing-library/react-native';
import React from 'react';
import { BehaviorSubject } from 'rxjs';

import { SignalWireVideoView } from './SignalWireVideoView';

function createStream(urlValue: string, trackId: string) {
  return {
    id: 'stream-1',
    toURL: jest.fn(() => urlValue),
    getVideoTracks: jest.fn(() => [{ id: trackId }])
  };
}

function createCall(local: unknown, remote: unknown) {
  return {
    id: 'call-1',
    status$: new BehaviorSubject('connected'),
    status: 'connected',
    participants$: new BehaviorSubject([]),
    participants: [],
    self$: new BehaviorSubject(null),
    self: null,
    localStream$: new BehaviorSubject(local),
    localStream: local,
    remoteStream$: new BehaviorSubject(remote),
    remoteStream: remote,
    errors$: new BehaviorSubject(null),
    hangup: jest.fn(),
    toggleHold: jest.fn(),
    sendDigits: jest.fn()
  };
}

describe('SignalWireVideoView', () => {
  it('renders nothing when there is no stream', async () => {
    const call = createCall(null, null);
    const { queryByTestId } = await render(<SignalWireVideoView call={call as never} kind="remote" />);
    expect(queryByTestId('signalwire-video')).toBeNull();
  });

  it('renders the remote stream URL', async () => {
    const call = createCall(null, createStream('mock://remote', 'track-r'));
    const { getByTestId } = await render(<SignalWireVideoView call={call as never} kind="remote" />);
    expect(getByTestId('signalwire-video').props.streamURL).toBe('mock://remote');
  });

  it('renders the local stream URL when kind is local', async () => {
    const call = createCall(createStream('mock://local', 'track-l'), null);
    const { getByTestId } = await render(<SignalWireVideoView call={call as never} kind="local" />);
    expect(getByTestId('signalwire-video').props.streamURL).toBe('mock://local');
  });

  it('mirrors a local view by default', async () => {
    const call = createCall(createStream('mock://local', 'track-l'), null);
    const { getByTestId } = await render(<SignalWireVideoView call={call as never} kind="local" />);
    expect(getByTestId('signalwire-video').props.mirror).toBe(true);
  });

  it('does not mirror a remote view by default', async () => {
    const call = createCall(null, createStream('mock://remote', 'track-r'));
    const { getByTestId } = await render(<SignalWireVideoView call={call as never} kind="remote" />);
    expect(getByTestId('signalwire-video').props.mirror).toBe(false);
  });

  it('honours an explicit mirror prop', async () => {
    const call = createCall(createStream('mock://local', 'track-l'), null);
    const { getByTestId } = await render(
      <SignalWireVideoView call={call as never} kind="local" mirror={false} />
    );
    expect(getByTestId('signalwire-video').props.mirror).toBe(false);
  });

  it('recomputes the URL when the track is replaced on the same stream object', async () => {
    const remote = createStream('mock://remote-v1', 'track-1');
    const call = createCall(null, remote);
    const { getByTestId, rerender } = await render(
      <SignalWireVideoView call={call as never} kind="remote" />
    );
    expect(getByTestId('signalwire-video').props.streamURL).toBe('mock://remote-v1');

    // Same stream object, new track and new URL — the camera-switch case.
    remote.getVideoTracks.mockReturnValue([{ id: 'track-2' }]);
    remote.toURL.mockReturnValue('mock://remote-v2');
    await rerender(<SignalWireVideoView call={call as never} kind="remote" />);

    expect(getByTestId('signalwire-video').props.streamURL).toBe('mock://remote-v2');
  });

  it('passes objectFit through', async () => {
    const call = createCall(null, createStream('mock://remote', 'track-r'));
    const { getByTestId } = await render(
      <SignalWireVideoView call={call as never} kind="remote" objectFit="contain" />
    );
    expect(getByTestId('signalwire-video').props.objectFit).toBe('contain');
  });

  it('renders nothing for a null call', async () => {
    const { queryByTestId } = await render(<SignalWireVideoView call={null} kind="remote" />);
    expect(queryByTestId('signalwire-video')).toBeNull();
  });
});
