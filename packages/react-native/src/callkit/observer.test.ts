jest.mock('./CallKeepBridge', () => {
  const bridge = { trackCall: jest.fn(), bindClient: jest.fn() };
  return { getCallKit: () => bridge };
});

import { getCallKit } from './CallKeepBridge';
import { createCallKitObserver } from './observer';

const bridge = getCallKit() as unknown as { trackCall: jest.Mock };

beforeEach(() => jest.clearAllMocks());

describe('createCallKitObserver', () => {
  it('names an outbound call by its destination by default', () => {
    createCallKitObserver().onOutgoingCall?.({ id: 'c1' } as never, '/private/agent');
    // call, handle, display name; later arguments are not this test's concern.
    expect(bridge.trackCall.mock.calls[0]?.slice(0, 3)).toEqual([{ id: 'c1' }, '/private/agent', '/private/agent']);
  });

  it('uses the display name it was given, keeping the destination as the handle', () => {
    const displayName = jest.fn(() => 'Support');
    createCallKitObserver({ displayName }).onOutgoingCall?.({ id: 'c2' } as never, '/private/agent');
    expect(displayName).toHaveBeenCalledWith('/private/agent');
    expect(bridge.trackCall.mock.calls[0]?.slice(0, 3)).toEqual([{ id: 'c2' }, '/private/agent', 'Support']);
  });
});
