import { mediaDevices, RTCPeerConnection, RTCRtpSender } from 'react-native-webrtc';

import { createWebRTCApiProvider } from './webrtc';

describe('createWebRTCApiProvider', () => {
  it('exposes react-native-webrtc RTCPeerConnection', () => {
    const provider = createWebRTCApiProvider();
    expect(provider.RTCPeerConnection).toBe(RTCPeerConnection);
  });

  it('forwards getUserMedia to react-native-webrtc', async () => {
    const provider = createWebRTCApiProvider();
    const constraints = { audio: true, video: false };
    await provider.mediaDevices.getUserMedia(constraints);
    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith(constraints);
  });

  it('forwards enumerateDevices', async () => {
    const provider = createWebRTCApiProvider();
    const devices = await provider.mediaDevices.enumerateDevices();
    expect(mediaDevices.enumerateDevices).toHaveBeenCalled();
    expect(devices[0]?.deviceId).toBe('mic-1');
  });

  it('omits getDisplayMedia so the SDK reports screen share unsupported', () => {
    const provider = createWebRTCApiProvider();
    expect(provider.mediaDevices.getDisplayMedia).toBeUndefined();
  });

  it('provides no-op device listeners that do not throw', () => {
    const provider = createWebRTCApiProvider();
    const listener = jest.fn();
    expect(() => provider.mediaDevices.addEventListener('devicechange', listener)).not.toThrow();
    expect(() => provider.mediaDevices.removeEventListener('devicechange', listener)).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it('shims RTCRtpSender.setStreams, which react-native-webrtc lacks', () => {
    // The SDK's inbound-answer path calls sender.setStreams on the transceivers
    // that setRemoteDescription created. Without the shim, answering ANY
    // inbound call threw "undefined is not a function" after the user had
    // already accepted on the native UI.
    createWebRTCApiProvider();

    // The runtime class is the jest mock; the type is the real module's, whose
    // constructor takes an argument the mock does not need.
    const MockSender = RTCRtpSender as unknown as new () => { setStreams?: (...s: unknown[]) => void };
    const sender = new MockSender();
    expect(typeof sender.setStreams).toBe('function');
    expect(() => sender.setStreams?.()).not.toThrow();
  });

  it('does not replace a real setStreams implementation', () => {
    const proto = (RTCRtpSender as unknown as { prototype: Record<string, unknown> }).prototype;
    const native = jest.fn();
    const previous = proto.setStreams;
    proto.setStreams = native;
    try {
      createWebRTCApiProvider();
      expect(proto.setStreams).toBe(native);
    } finally {
      proto.setStreams = previous;
    }
  });
});
