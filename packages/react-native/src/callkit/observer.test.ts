import { createCallKitObserver } from './observer';

const mockBridge = { trackCall: jest.fn(), bindClient: jest.fn() };

jest.mock('./CallKeepBridge', () => ({ getCallKit: () => mockBridge }));

describe('createCallKitObserver', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reports an audio dial as audio', () => {
    createCallKitObserver().onOutgoingCall?.({ id: 'c1' } as never, '/public/room', {
      audio: true,
      video: false
    });
    expect(mockBridge.trackCall).toHaveBeenCalledWith(
      { id: 'c1' },
      '/public/room',
      '/public/room',
      false
    );
  });

  it('reports a dial with no options as audio, the SDK default', () => {
    createCallKitObserver().onOutgoingCall?.({ id: 'c1' } as never, '/public/room');
    expect(mockBridge.trackCall).toHaveBeenCalledWith(
      { id: 'c1' },
      '/public/room',
      '/public/room',
      false
    );
  });

  it.each([
    ['video: true', { video: true }],
    ['video constraints', { inputVideoDeviceConstraints: { facingMode: 'user' } }],
    ['a video stream', { inputVideoStream: {} }]
  ])('reports a dial that sends video (%s) as video', (_name, options) => {
    createCallKitObserver().onOutgoingCall?.({ id: 'c1' } as never, '/public/room', options as never);
    expect(mockBridge.trackCall).toHaveBeenCalledWith(
      { id: 'c1' },
      '/public/room',
      '/public/room',
      true
    );
  });
});
