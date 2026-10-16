import { useCallback, useRef } from 'react';

import { useObservable } from './useObservable';

import type {
  Call,
  CallError,
  CallParticipant,
  CallSelfParticipant,
  CallStatus
} from '@signalwire/js';
import type { Observable } from 'rxjs';

const NO_PARTICIPANTS: CallParticipant[] = [];

export interface UseCallResult {
  readonly status: CallStatus;
  readonly participants: CallParticipant[];
  readonly self: CallSelfParticipant | null;
  readonly localStream: MediaStream | null;
  readonly remoteStream: MediaStream | null;
  readonly isAudioMuted: boolean;
  readonly isVideoMuted: boolean;
  /** The most recent error emitted by this call, or null. */
  readonly error: CallError | null;
  hangup(): Promise<void>;
  toggleHold(): Promise<void>;
  setAudioMuted(muted: boolean): Promise<void>;
  setVideoMuted(muted: boolean): Promise<void>;
  sendDigits(digits: string): Promise<void>;
}

/**
 * Reads a property that may throw, treating a throw as absence.
 *
 * The SDK's getters are not merely lazy — some throw once the call is torn
 * down. `status$` builds on `signalingStatus$`, which dereferences
 * `mainPeerConnection`, and that getter throws `DependencyError` after the
 * peer connection is destroyed. A late emission then re-renders a still-
 * mounted component, `useCall` reads `call.status$`, and the render throws —
 * surfacing as an error toast after every completed call.
 *
 * "Safe with a null call" has to include a dead one: last-known/fallback
 * state during teardown beats throwing in render.
 */
function guard<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * `owner`'s observable, read until a read succeeds and then kept for as long
 * as `owner` is the same object. useObservable starts over when its source
 * changes, and a torn-down call's getters throw: re-reading them every
 * render handed it `undefined` and wiped the call's last-known state. A read
 * that fails before the call is set up is retried on the next render.
 */
function useSource<O extends object, T>(
  owner: O | null | undefined,
  read: (owner: O) => Observable<T>
): Observable<T> | undefined {
  const cache = useRef<{ owner: O | null | undefined; source: Observable<T> | undefined }>(
    undefined
  );
  const cached = cache.current;
  if (cached && cached.owner === owner && cached.source !== undefined) {
    return cached.source;
  }
  const source = owner ? guard(() => read(owner)) : undefined;
  cache.current = { owner, source };
  return source;
}

/** Reactive state and actions for a single call. Safe with a null call. */
export function useCall(call: Call | null | undefined): UseCallResult {
  const status = useObservable<CallStatus>(
    useSource(call, (c) => c.status$),
    guard(() => call?.status) ?? ('new' as CallStatus)
  );
  const participants = useObservable(
    useSource(call, (c) => c.participants$),
    guard(() => call?.participants) ?? NO_PARTICIPANTS
  );
  const self = useObservable(
    useSource(call, (c) => c.self$),
    guard(() => call?.self) ?? null
  );
  const localStream = useObservable<MediaStream | null>(
    useSource(call, (c) => c.localStream$),
    guard(() => call?.localStream) ?? null
  );
  const remoteStream = useObservable<MediaStream | null>(
    useSource(call, (c) => c.remoteStream$),
    guard(() => call?.remoteStream) ?? null
  );
  const error = useObservable<CallError | null>(
    useSource(call, (c) => c.errors$),
    null
  );

  // audioMuted$ / videoMuted$ emit `undefined` until server data arrives.
  const audioMuted = useObservable<boolean | undefined>(
    useSource(self, (s) => s.audioMuted$),
    guard(() => self?.audioMuted)
  );
  const videoMuted = useObservable<boolean | undefined>(
    useSource(self, (s) => s.videoMuted$),
    guard(() => self?.videoMuted)
  );

  const hangup = useCallback((): Promise<void> => call?.hangup() ?? Promise.resolve(), [call]);

  const toggleHold = useCallback(
    (): Promise<void> => call?.toggleHold() ?? Promise.resolve(),
    [call]
  );

  const setAudioMuted = useCallback(
    (muted: boolean): Promise<void> => {
      const participant = call?.self;
      if (!participant) {
        return Promise.resolve();
      }
      return muted ? participant.mute() : participant.unmute();
    },
    [call]
  );

  const setVideoMuted = useCallback(
    (muted: boolean): Promise<void> => {
      const participant = call?.self;
      if (!participant) {
        return Promise.resolve();
      }
      return muted ? participant.muteVideo() : participant.unmuteVideo();
    },
    [call]
  );

  const sendDigits = useCallback(
    (digits: string): Promise<void> => call?.sendDigits(digits) ?? Promise.resolve(),
    [call]
  );

  return {
    status,
    participants,
    self,
    localStream,
    remoteStream,
    isAudioMuted: audioMuted ?? false,
    isVideoMuted: videoMuted ?? false,
    error,
    hangup,
    toggleHold,
    setAudioMuted,
    setVideoMuted,
    sendDigits
  };
}
