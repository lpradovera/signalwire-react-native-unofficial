import type { ClientPreferences, DialOptions } from '@signalwire/js';

/** The client preferences that bear on whether a dial carries video. */
export type VideoPreferences = Partial<Pick<ClientPreferences, 'receiveVideo' | 'inputVideoConstraints'>>;

/** The media options a destination's `?channel=` query implies, as the SDK reads it. */
function channelOptions(destination: string): DialOptions {
  const query = destination.indexOf('?');
  if (query === -1) {
    return {};
  }
  const channel = new URLSearchParams(destination.slice(query + 1)).get('channel');
  if (channel === 'video') {
    return { audio: true, video: true, receiveVideo: true };
  }
  if (channel === 'audio') {
    return { audio: true, video: false };
  }
  return {};
}

/**
 * Whether a dial is a video call: it sends or receives video.
 *
 * Mirrors `SignalWire.dial`, which merges the client preferences, then the
 * destination's `?channel=`, then the dial options (highest priority), and
 * sends video when the merged options ask for a camera (`video`, video
 * constraints or a video stream) and receives it when they say `receiveVideo`.
 */
export function dialsVideo(
  destination: string,
  options: DialOptions | undefined,
  preferences?: VideoPreferences
): boolean {
  const merged: DialOptions = {
    receiveVideo: preferences?.receiveVideo,
    inputVideoDeviceConstraints: preferences?.inputVideoConstraints,
    ...channelOptions(destination),
    ...options
  };
  const sends = Boolean(merged.video || merged.inputVideoDeviceConstraints || merged.inputVideoStream);
  return sends || Boolean(merged.receiveVideo);
}
