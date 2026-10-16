import { render } from '@testing-library/react-native';
import React from 'react';
import { BehaviorSubject } from 'rxjs';

import { SignalWireVideoView } from './SignalWireVideoView';

function createStream(urlValue: string, trackId: string, facingMode?: string) {
  return {
    id: 'stream-1',
    toURL: jest.fn(() => urlValue),
    getVideoTracks: jest.fn(() => [{ id: trackId, getSettings: () => ({ facingMode }) }])
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

  it('does not mirror a local back camera by default', async () => {
    const call = createCall(createStream('mock://local', 'track-l', 'environment'), null);
    const { getByTestId } = await render(<SignalWireVideoView call={call as never} kind="local" />);
    expect(getByTestId('signalwire-video').props.mirror).toBe(false);
  });

  it('mirrors a local front camera by default', async () => {
    const call = createCall(createStream('mock://local', 'track-l', 'user'), null);
    const { getByTestId } = await render(<SignalWireVideoView call={call as never} kind="local" />);
    expect(getByTestId('signalwire-video').props.mirror).toBe(true);
  });

  it('lets an explicit mirror prop mirror a back camera', async () => {
    const call = createCall(createStream('mock://local', 'track-l', 'environment'), null);
    const { getByTestId } = await render(
      <SignalWireVideoView call={call as never} kind="local" mirror />
    );
    expect(getByTestId('signalwire-video').props.mirror).toBe(true);
  });

  it('keeps its place but passes no stream URL when the stream has no video track', async () => {
    const call = createCall(null, { toURL: () => 'mock://audio-only', getVideoTracks: () => [] });
    const { getByTestId } = await render(<SignalWireVideoView call={call as never} kind="remote" />);
    expect(getByTestId('signalwire-video').props.streamURL).toBeUndefined();
  });

  it('subscribes to its own stream only', async () => {
    const call = createCall(
      createStream('mock://local', 'track-l'),
      createStream('mock://remote', 'track-r')
    );
    await render(<SignalWireVideoView call={call as never} kind="local" />);
    expect(call.localStream$.observed).toBe(true);
    expect(call.remoteStream$.observed).toBe(false);
    expect(call.status$.observed).toBe(false);
    expect(call.participants$.observed).toBe(false);
    expect(call.errors$.observed).toBe(false);
  });

  it('renders nothing for a call whose stream getters throw after teardown', async () => {
    const dead = {
      get localStream$(): never {
        throw new Error('DependencyError: mainPeerConnection');
      },
      get localStream(): never {
        throw new Error('DependencyError: mainPeerConnection');
      }
    };
    const { queryByTestId } = await render(<SignalWireVideoView call={dead as never} kind="local" />);
    expect(queryByTestId('signalwire-video')).toBeNull();
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
