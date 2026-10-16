jest.mock('./CallKeepBridge', () => {
  const bridge = { trackCall: jest.fn(), bindClient: jest.fn() };
  return { getCallKit: () => bridge };
});

import { logger } from '@signalwire/react';

import { getCallKit } from './CallKeepBridge';
import { createCallKitObserver } from './observer';

const bridge = getCallKit() as unknown as { trackCall: jest.Mock };

beforeEach(() => jest.clearAllMocks());

describe('createCallKitObserver', () => {
  it("names an outbound call by its destination's readable name by default, not the raw Fabric address", () => {
    createCallKitObserver().onOutgoingCall?.({ id: 'c1' } as never, '/private/rn-device-test');
    // call, handle, display name; later arguments are not this test's concern.
    expect(bridge.trackCall.mock.calls[0]?.slice(0, 3)).toEqual([{ id: 'c1' }, '/private/rn-device-test', 'Rn Device Test']);
  });

  it('names a call to a number or plain name by the destination', () => {
    createCallKitObserver().onOutgoingCall?.({ id: 'c5' } as never, '+15551234');
    expect(bridge.trackCall.mock.calls[0]?.[2]).toBe('+15551234');
  });

  it('keeps the destination when it has no readable name', () => {
    createCallKitObserver().onOutgoingCall?.({ id: 'c6' } as never, '/private/');
    expect(bridge.trackCall.mock.calls[0]?.[2]).toBe('/private/');
  });

  it("makes a Fabric address the app's displayName returns readable", () => {
    createCallKitObserver(() => ({ displayName: () => '/public/front-desk' })).onOutgoingCall?.(
      { id: 'c7' } as never,
      '/private/agent'
    );
    expect(bridge.trackCall.mock.calls[0]?.[2]).toBe('Front Desk');
  });

  it("logs a placeholder name from displayName and doesn't show it", () => {
    const debug = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
    createCallKitObserver(() => ({ displayName: () => '_undef_' })).onOutgoingCall?.({ id: 'c8' } as never, '/private/agent');
    expect(bridge.trackCall.mock.calls[0]?.[2]).toBe('Agent');
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('placeholder name "_undef_"'));
    debug.mockRestore();
  });

  it('uses the display name it was given, keeping the destination as the handle', () => {
    const displayName = jest.fn(() => 'Support');
    createCallKitObserver(() => ({ displayName })).onOutgoingCall?.({ id: 'c2' } as never, '/private/agent');
    expect(displayName).toHaveBeenCalledWith('/private/agent');
    expect(bridge.trackCall.mock.calls[0]?.slice(0, 3)).toEqual([{ id: 'c2' }, '/private/agent', 'Support']);
  });

  it('names the call by its destination when displayName throws, so the placed call is still tracked', () => {
    // dial() has already placed the call when this runs: a throw here would
    // reject dial(), and the app would never get the live call to hang up.
    const displayName = (to: string): string => {
      throw new Error(`no contact for ${to}`);
    };
    const observer = createCallKitObserver(() => ({ displayName }));

    expect(() => observer.onOutgoingCall?.({ id: 'c3' } as never, '/private/agent')).not.toThrow();
    expect(bridge.trackCall.mock.calls[0]?.slice(0, 3)).toEqual([{ id: 'c3' }, '/private/agent', 'Agent']);
  });

  it('names the call by its destination when displayName returns an empty name', () => {
    createCallKitObserver(() => ({ displayName: () => '' })).onOutgoingCall?.({ id: 'c4' } as never, '/private/agent');
    expect(bridge.trackCall.mock.calls[0]?.[2]).toBe('Agent');
  });
});
