import { SignalWireContext } from '@signalwire/react';
import { render } from '@testing-library/react-native';
import React from 'react';

import { getCallKit, resetCallKitForTesting } from '../callkit/CallKeepBridge';
import { PushWakeRenewal } from './PushWakeRenewal';

import type { SignalWireContextValue } from '@signalwire/react';

function contextWith(overrides: Partial<SignalWireContextValue>): SignalWireContextValue {
  return { client: null, error: null, observer: undefined, ...overrides };
}

afterEach(() => resetCallKitForTesting());

describe('PushWakeRenewal', () => {
  it('renews the token when a call push arrives, once per push', async () => {
    const renewTokenIfDue = jest.fn();
    await render(
      <SignalWireContext.Provider value={contextWith({ renewTokenIfDue })}>
        <PushWakeRenewal />
      </SignalWireContext.Provider>
    );

    getCallKit().reportIncomingPush({ callId: 'c-1', from: '+15551230000' });
    expect(renewTokenIfDue).toHaveBeenCalledTimes(1);

    // The registry republishes its entries on every change; the same push
    // is not a new wake-up.
    getCallKit().registry.applyIntent(getCallKit().registry.entries[0]!.uuid, 'answer');
    expect(renewTokenIfDue).toHaveBeenCalledTimes(1);

    getCallKit().reportIncomingPush({ callId: 'c-2', from: '+15551230001' });
    expect(renewTokenIfDue).toHaveBeenCalledTimes(2);
  });

  it('renews for a push that arrived before it mounted (a cold start)', async () => {
    getCallKit().reportIncomingPush({ callId: 'c-cold', from: '+15551230000' });
    const renewTokenIfDue = jest.fn();
    await render(
      <SignalWireContext.Provider value={contextWith({ renewTokenIfDue })}>
        <PushWakeRenewal />
      </SignalWireContext.Provider>
    );
    expect(renewTokenIfDue).toHaveBeenCalledTimes(1);
  });

  it('says so in the log when a push rings while the token is refused', async () => {
    const { logger } = jest.requireActual('@signalwire/react');
    const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    await render(
      <SignalWireContext.Provider
        value={contextWith({
          renewTokenIfDue: jest.fn(),
          tokenStatus: { state: 'unauthorized', expiresAt: undefined, error: new Error('401') }
        })}
      >
        <PushWakeRenewal />
      </SignalWireContext.Provider>
    );
    getCallKit().reportIncomingPush({ callId: 'c-3', from: '+15551230000' });
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/cannot connect.*unauthorized/i), expect.anything());
    error.mockRestore();
  });
});
