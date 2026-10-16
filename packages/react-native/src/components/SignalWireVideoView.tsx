import React from 'react';
import { RTCView } from 'react-native-webrtc';
import { map } from 'rxjs';

import { useObservable } from '@signalwire/react';

import type { Call } from '@signalwire/js';
import type { StyleProp, ViewStyle } from 'react-native';
import type { Observable } from 'rxjs';

export interface SignalWireVideoViewProps {
  call: Call | null | undefined;
  /** Which side of the call to render. */
  kind: 'local' | 'remote';
  objectFit?: 'contain' | 'cover';
  /**
   * Flip the picture horizontally. By default a local view is mirrored unless
   * its camera reports `facingMode: 'environment'` (a back camera), and a
   * remote view is not mirrored. An explicit value always wins.
   */
  mirror?: boolean;
  zOrder?: number;
  style?: StyleProp<ViewStyle>;
}

interface VideoTrackLike {
  id: string;
  getSettings?(): { facingMode?: string };
}

interface VideoCapableStream {
  toURL(): string;
  getVideoTracks?(): VideoTrackLike[];
}

/** One stream emission. A fresh wrapper per emission, so a re-emitted stream still renders. */
interface StreamEmission {
  stream: VideoCapableStream | null;
}

/**
 * Reads a call property that may throw, treating a throw as absence. The SDK's
 * getters throw once the call's peer connection is torn down; see `guard` in
 * `useCall` (@signalwire/react).
 */
function guard<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * Renders one side of a call.
 *
 * The SDK swaps video tracks in place: video mute then unmute, a camera
 * switch, and the server-pushed-constraints fallback remove the old track from
 * the same `MediaStream`, add a new one, and emit that same stream again. Its
 * `toURL()` does not change (react-native-webrtc returns the stream's fixed
 * tag), and the native view picks the stream's first video track only when
 * its `streamURL` is set, so the URL alone never signals the swap.
 *
 * So the view re-renders on every emission of the stream, even an identical
 * one, reads the current first video track, and keys the `RTCView` on the
 * stream and that track. A new track remounts the native view, which then
 * looks the track up afresh. The lookup and react-native-webrtc's own
 * `addTrack` run on the same serial WebRTC queue on both platforms, so the new
 * view finds the new track. With no video track (video off) the view keeps its
 * place but draws nothing, rather than the stopped track's last frame.
 */
export function SignalWireVideoView({
  call,
  kind,
  objectFit = 'cover',
  mirror,
  zOrder,
  style
}: SignalWireVideoViewProps): React.JSX.Element | null {
  // react-native-webrtc's MediaStream, which the DOM `MediaStream` type does not describe.
  const stream$ = guard((): Observable<unknown> | undefined =>
    kind === 'local' ? call?.localStream$ : call?.remoteStream$
  );
  const current = guard((): unknown => (kind === 'local' ? call?.localStream : call?.remoteStream));
  const { stream } = useObservable<StreamEmission>(
    stream$?.pipe(map((next) => ({ stream: (next ?? null) as VideoCapableStream | null }))),
    { stream: (current ?? null) as VideoCapableStream | null }
  );

  const streamURL = stream?.toURL() ?? null;
  if (!stream || !streamURL) {
    return null;
  }

  const videoTracks = stream.getVideoTracks?.();
  const videoTrack = videoTracks?.[0];
  const facingMode = guard(() => videoTrack?.getSettings?.().facingMode);
  // No `getVideoTracks` means the tracks are unknown: render the URL as is.
  const hasVideo = !videoTracks || Boolean(videoTrack);

  return (
    <RTCView
      key={`${streamURL}:${videoTrack?.id ?? ''}`}
      testID="signalwire-video"
      streamURL={hasVideo ? streamURL : undefined}
      objectFit={objectFit}
      mirror={mirror ?? (kind === 'local' && facingMode !== 'environment')}
      zOrder={zOrder}
      style={style}
    />
  );
}
