import React from 'react';
import { View } from 'react-native';

export class RTCPeerConnection {
  public onicecandidate: unknown = null;
  addTrack = jest.fn();
  close = jest.fn();
}

export class MediaStream {
  public id = 'mock-stream';
  private tracks: unknown[] = [];
  getTracks = jest.fn(() => this.tracks);
  getVideoTracks = jest.fn(() => this.tracks);
  toURL = jest.fn(() => 'mock://stream');
}

/** Like the real module: no setStreams — the shim under test must add it. */
export class RTCRtpSender {
  replaceTrack = jest.fn(async () => undefined);
}

export const mediaDevices = {
  getUserMedia: jest.fn(async () => new MediaStream()),
  enumerateDevices: jest.fn(async () => [
    { deviceId: 'mic-1', kind: 'audioinput', label: 'Built-in Mic', groupId: '' }
  ])
};

export const RTCView = (props: Record<string, unknown>): React.ReactElement =>
  React.createElement(View, props);

export const registerGlobals = jest.fn();
