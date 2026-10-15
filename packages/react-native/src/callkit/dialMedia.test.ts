jest.mock('./CallKeepBridge', () => {
  const bridge = { trackCall: jest.fn(), bindClient: jest.fn() };
  return { getCallKit: () => bridge };
});

import { getCallKit } from './CallKeepBridge';
import { dialsVideo } from './dialMedia';
import { createCallKitObserver } from './observer';

const bridge = getCallKit() as unknown as { trackCall: jest.Mock };

beforeEach(() => jest.clearAllMocks());

describe('dialsVideo', () => {
  it('is a voice call by default, as in the SDK', () => {
    expect(dialsVideo('/public/room', undefined)).toBe(false);
    expect(dialsVideo('/public/room', { audio: true })).toBe(false);
  });

  it('is a video call when it sends video', () => {
    expect(dialsVideo('/public/room', { video: true })).toBe(true);
    expect(dialsVideo('/public/room', { inputVideoDeviceConstraints: { width: 640 } })).toBe(true);
  });

  it('is a video call when it only receives video', () => {
    expect(dialsVideo('/public/room', { receiveVideo: true })).toBe(true);
  });

  it('follows the client preferences, which the dial options override', () => {
    expect(dialsVideo('/public/room', undefined, { receiveVideo: true })).toBe(true);
    expect(dialsVideo('/public/room', undefined, { inputVideoConstraints: { width: 640 } })).toBe(true);
    expect(dialsVideo('/public/room', { receiveVideo: false }, { receiveVideo: true })).toBe(false);
  });

  it('follows the destination channel, which the dial options override', () => {
    expect(dialsVideo('/public/room?channel=video', undefined)).toBe(true);
    expect(dialsVideo('/public/room?channel=audio', undefined, { receiveVideo: true })).toBe(true);
    expect(dialsVideo('/public/room?channel=video', { video: false, receiveVideo: false })).toBe(false);
  });
});

describe('createCallKitObserver call type', () => {
  it('reports a receive-only video call as video', () => {
    createCallKitObserver().onOutgoingCall?.({ id: 'c1' } as never, '/public/room', { receiveVideo: true });
    expect(bridge.trackCall.mock.calls[0]?.[3]).toEqual({ video: true });
  });

  it('reports a call as video when the client preferences enable video', () => {
    const observer = createCallKitObserver();
    observer.bindClient?.({ preferences: { receiveVideo: true } } as never);
    observer.onOutgoingCall?.({ id: 'c2' } as never, '/public/room');
    expect(bridge.trackCall.mock.calls[0]?.[3]).toEqual({ video: true });
  });

  it('reports a plain dial as voice', () => {
    createCallKitObserver().onOutgoingCall?.({ id: 'c3' } as never, '/public/room');
    expect(bridge.trackCall.mock.calls[0]?.[3]).toEqual({ video: false });
  });
});
