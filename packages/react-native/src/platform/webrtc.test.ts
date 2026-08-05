import { mediaDevices, RTCPeerConnection } from 'react-native-webrtc';

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
});
