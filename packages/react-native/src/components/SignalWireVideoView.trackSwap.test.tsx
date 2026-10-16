/**
 * SignalWireVideoView against the real track-swap behaviour.
 *
 * The SDK replaces a video track in place: video mute then unmute, a camera
 * switch, and the server-pushed-constraints fallback all remove the old track
 * from the SAME MediaStream, add a new one, and re-emit that same stream.
 * These tests drive the SDK's own LocalStreamController and
 * TransceiverController (evaluated from the shipped @signalwire/js bundle,
 * since the package does not export them) over react-native-webrtc's real
 * MediaStream and MediaStreamTrack classes, whose toURL() is a fixed tag for
 * the life of the stream.
 *
 * Only the native view is simulated, following the native code in
 * react-native-webrtc 124: a view looks up the stream's first video track
 * when its streamURL prop is set to a new value (iOS RTCVideoViewManager's
 * streamURL setter; Android WebRTCView.setStreamURL returns early on an equal
 * URL), and only changed props reach an existing view.
 */
import { act, render } from '@testing-library/react-native';
import React from 'react';
import { NativeModules } from 'react-native';
import { asapScheduler, BehaviorSubject } from 'rxjs';
import { filter, observeOn } from 'rxjs/operators';

import type { Observable } from 'rxjs';

interface NativeTrack {
  id: string;
  readyState: string;
}
interface NativeStream {
  getVideoTracks(): NativeTrack[];
}

const mockNative = {
  /** streamURL -> stream, as WebRTCModule's streamForReactTag resolves it. */
  streams: new Map<string, NativeStream>(),
  /** The track the most recently rendered native view is drawing. */
  shownTrack: null as NativeTrack | null,
  shownMirror: undefined as boolean | undefined
};

jest.mock('react-native-webrtc', () => {
  const R = require('react');
  const { View } = require('react-native');
  return {
    RTCView: (props: { streamURL?: string; mirror?: boolean }) => {
      // One ref per native view instance: a remount is a new native view.
      const view = R.useRef({ streamURL: undefined as string | undefined, track: null });
      if (props.streamURL !== view.current.streamURL) {
        view.current.streamURL = props.streamURL;
        const stream = props.streamURL ? mockNative.streams.get(props.streamURL) : undefined;
        const first = stream?.getVideoTracks()[0];
        // iOS logs "No video stream" and leaves the view's track as it was.
        if (first) {
          view.current.track = first;
        }
      }
      mockNative.shownTrack = view.current.track;
      mockNative.shownMirror = props.mirror;
      return R.createElement(View, props);
    }
  };
});

(NativeModules as Record<string, unknown>).WebRTCModule = {
  addListener: jest.fn(),
  removeListeners: jest.fn(),
  mediaStreamCreate: jest.fn(),
  mediaStreamAddTrack: jest.fn(),
  mediaStreamRemoveTrack: jest.fn(),
  mediaStreamRelease: jest.fn(),
  mediaStreamTrackSetEnabled: jest.fn(),
  mediaStreamTrackRelease: jest.fn()
};

const RealMediaStream = jest.requireActual('react-native-webrtc/src/MediaStream').default;
const RealMediaStreamTrack = jest.requireActual('react-native-webrtc/src/MediaStreamTrack').default;

import { SignalWireVideoView } from './SignalWireVideoView';

// ---- The SDK's stream and transceiver controllers, from the shipped bundle --

// This package has no Node typings; the test only needs these few calls.
const fs: {
  readFileSync(file: string, encoding: 'utf8'): string;
  readdirSync(dir: string): string[];
} = jest.requireActual('fs');
const path: { dirname(file: string): string; join(...parts: string[]): string } =
  jest.requireActual('path');
const resolveModule = (require as unknown as { resolve(id: string): string }).resolve;

const SDK_DIST = path.dirname(resolveModule('@signalwire/js'));

function sdkRegion(source: string, region: string): string {
  const start = source.indexOf(`//#region ${region}`);
  const end = source.indexOf('//#endregion', start);
  if (start < 0 || end < 0) {
    throw new Error(`@signalwire/js bundle has no region ${region}; the SDK layout changed`);
  }
  return source.slice(start, end);
}

function loadSdkControllers() {
  const source = fs.readFileSync(path.join(SDK_DIST, 'index.cjs'), 'utf8');
  const chunk = fs.readdirSync(SDK_DIST).find((name: string) => /^operators-.*\.cjs$/.test(name));
  if (!chunk) {
    throw new Error('@signalwire/js bundle has no operators chunk; the SDK layout changed');
  }
  const requireOperators = jest.requireActual(path.join(SDK_DIST, chunk));
  const rxjs = jest.requireActual('rxjs');
  return new Function(
    'require_operators',
    'rxjs',
    [
      sdkRegion(source, 'src/behaviors/Destroyable.ts'),
      // @signalwire/js 4.0.0-rc.5: TransceiverController's replaceTrackFallback
      // calls getUserMediaWithFallback from this module.
      ...(source.includes('//#region src/controllers/ConstraintFallbackHelper.ts')
        ? [sdkRegion(source, 'src/controllers/ConstraintFallbackHelper.ts')]
        : []),
      sdkRegion(source, 'src/controllers/LocalStreamController.ts'),
      sdkRegion(source, 'src/controllers/TransceiverController.ts'),
      'return { LocalStreamController, TransceiverController };'
    ].join('\n')
  )(requireOperators, rxjs);
}

const { LocalStreamController, TransceiverController } = loadSdkControllers();

// ---- react-native-webrtc's getUserMedia, as its native success callback builds it

let trackSeq = 0;

function nativeTrack(kind: 'audio' | 'video', facingMode?: string) {
  trackSeq += 1;
  return {
    id: `${kind === 'video' ? 'cam' : 'mic'}-${trackSeq}`,
    kind,
    remote: false,
    constraints: {},
    enabled: true,
    settings: facingMode ? { facingMode } : {},
    peerConnectionId: -1,
    readyState: 'live'
  };
}

function getUserMedia(constraints: { audio?: unknown; video?: unknown }, facingMode = 'user') {
  const tracks: unknown[] = [];
  if (constraints.audio) tracks.push(nativeTrack('audio'));
  if (constraints.video) tracks.push(nativeTrack('video', facingMode));
  const id = `stream-${trackSeq}`;
  const stream = new RealMediaStream({ streamId: id, streamReactTag: id, tracks });
  mockNative.streams.set(stream.toURL(), stream);
  return Promise.resolve(stream);
}

function transceiver(kind: 'audio' | 'video', track: unknown) {
  const sender = {
    track,
    replaceTrack: jest.fn(async (next: unknown) => {
      sender.track = next;
    })
  };
  return { receiver: { track: { kind } }, sender, direction: 'sendrecv' };
}

/** A local call whose `localStream$` is wired the way WebRTCCall wires it. */
async function startLocalVideo() {
  const errors: unknown[] = [];
  const streams = new LocalStreamController({
    getUserMedia,
    inputAudioDeviceConstraints: true,
    inputVideoDeviceConstraints: true
  });
  const stream = await streams.buildLocalStream();
  const videoTransceiver = transceiver('video', stream.getVideoTracks()[0]);
  const transceivers = [transceiver('audio', stream.getAudioTracks()[0]), videoTransceiver];
  const media = new TransceiverController({
    peerConnection: { getTransceivers: () => transceivers },
    localStreamController: streams,
    getUserMedia,
    getInputAudioDeviceConstraints: () => true,
    getInputVideoDeviceConstraints: () => true,
    receiveAudio: true,
    receiveVideo: true,
    onError: (error: unknown) => errors.push(error)
  });
  // VertoManager filters nulls; WebRTCCall defers emission to the asap scheduler.
  const call = {
    get localStream$(): Observable<unknown> {
      return (streams.localStream$ as Observable<unknown>).pipe(
        filter((value) => value != null),
        observeOn(asapScheduler)
      );
    },
    get localStream() {
      return streams.localStream;
    },
    remoteStream$: new BehaviorSubject(null),
    remoteStream: null
  };
  return { call, stream, streams, media, videoSender: videoTransceiver.sender, errors };
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe('SignalWireVideoView across an in-place track swap', () => {
  beforeEach(() => {
    mockNative.streams.clear();
    mockNative.shownTrack = null;
    mockNative.shownMirror = undefined;
  });

  it('renders the new camera track after video mute then unmute', async () => {
    const { call, stream, streams, media, errors } = await startLocalVideo();
    const firstCam = stream.getVideoTracks()[0];
    await render(<SignalWireVideoView call={call as never} kind="local" />);
    await settle();
    expect(mockNative.shownTrack).toBe(firstCam);

    // SelfParticipant.muteVideo / unmuteVideo end in these two calls.
    await act(async () => {
      media.stopTrackSender('video');
    });
    await settle();
    await act(async () => {
      await media.restoreTrackSender('video');
    });
    await settle();

    const live = streams.localStream.getVideoTracks()[0];
    expect(streams.localStream).toBe(stream);
    expect(live).not.toBe(firstCam);
    expect(firstCam.readyState).toBe('ended');
    expect(mockNative.shownTrack).toBe(live);
    expect(errors).toHaveLength(0);
  });

  it('renders the replacement track after the constraints fallback', async () => {
    const { call, streams, media, videoSender, errors } = await startLocalVideo();
    await render(<SignalWireVideoView call={call as never} kind="local" />);
    await settle();
    const before = streams.localStream.getVideoTracks()[0];

    await act(async () => {
      await media.replaceTrackFallback(videoSender, before, 'video', {});
    });
    await settle();

    const after = streams.localStream.getVideoTracks()[0];
    expect(after).not.toBe(before);
    expect(mockNative.shownTrack).toBe(after);
    expect(errors).toHaveLength(0);
  });

  it('follows a switch to the back camera, and stops mirroring it', async () => {
    const { call, streams } = await startLocalVideo();
    await render(<SignalWireVideoView call={call as never} kind="local" />);
    await settle();
    expect(mockNative.shownMirror).toBe(true);

    // RTCPeerConnectionController.updateSelectedInputDevice: remove, then add.
    const front = streams.localStream.getVideoTracks()[0];
    const back = (await getUserMedia({ video: true }, 'environment')).getVideoTracks()[0];
    await act(async () => {
      streams.removeTrack(front.id);
      streams.addTrack(back);
    });
    await settle();

    expect(mockNative.shownTrack).toBe(back);
    expect(mockNative.shownMirror).toBe(false);
  });

  it('drops the stopped track while video is off', async () => {
    const { call, stream, media } = await startLocalVideo();
    await render(<SignalWireVideoView call={call as never} kind="local" />);
    await settle();
    expect(mockNative.shownTrack).toBe(stream.getVideoTracks()[0]);

    await act(async () => {
      media.stopTrackSender('video');
    });
    await settle();

    expect(stream.getVideoTracks()).toHaveLength(0);
    expect(mockNative.shownTrack).toBeNull();
  });

  it('renders a new remote track added to the same remote stream', async () => {
    const first = new RealMediaStreamTrack({ ...nativeTrack('video'), remote: true });
    const remote = new RealMediaStream({ streamId: 'r', streamReactTag: 'r', tracks: [] });
    remote._tracks.push(first);
    mockNative.streams.set(remote.toURL(), remote);
    const remoteStream$ = new BehaviorSubject(remote);
    const call = {
      localStream$: new BehaviorSubject(null),
      localStream: null,
      remoteStream$,
      get remoteStream() {
        return remoteStream$.value;
      }
    };
    await render(<SignalWireVideoView call={call as never} kind="remote" />);
    expect(mockNative.shownTrack).toBe(first);
    expect(mockNative.shownMirror).toBe(false);

    const second = new RealMediaStreamTrack({ ...nativeTrack('video'), remote: true });
    await act(async () => {
      remote._tracks.splice(0, 1, second);
      remoteStream$.next(remote);
    });

    expect(mockNative.shownTrack).toBe(second);
  });
});
