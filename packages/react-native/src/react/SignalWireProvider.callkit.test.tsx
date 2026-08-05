import { act, render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

jest.mock('@signalwire/js', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BehaviorSubject, Subject } = require('rxjs');
  const harness = {
    destroy: jest.fn(),
    disconnect: jest.fn(async () => undefined),
    dial: jest.fn(async () => ({ id: 'call-1' })),
    isConnected$: new BehaviorSubject(false),
    isRegistered$: new BehaviorSubject(false),
    user$: new BehaviorSubject(undefined),
    directory$: new BehaviorSubject(undefined),
    errors$: new Subject()
  };
  return {
    SignalWire: jest.fn(function SignalWireMock() {
      return harness;
    }),
    getLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
    __harness: harness
  };
});

jest.mock('../platform/createReactNativePlatform');
jest.mock('../callkit/lazy');

import * as sdk from '@signalwire/js';

import { loadCallKit } from '../callkit/lazy';
import { createReactNativePlatform } from '../platform/createReactNativePlatform';
import { SignalWireProvider } from './SignalWireProvider';
import { useSignalWire } from './useSignalWire';

const harness = (sdk as unknown as { __harness: { dial: jest.Mock } }).__harness;
const createPlatform = createReactNativePlatform as jest.MockedFunction<
  typeof createReactNativePlatform
>;
const load = loadCallKit as jest.MockedFunction<typeof loadCallKit>;

const bindClient = jest.fn();
const trackCall = jest.fn(() => 'uuid-1');

const credentialProvider = { authenticate: jest.fn(async () => ({ token: 't' })) };

let dialFn: ((destination: string) => Promise<unknown>) | undefined;

function Probe(): React.JSX.Element {
  dialFn = useSignalWire().dial;
  return <Text>ok</Text>;
}

function renderWith(callKit: boolean): ReturnType<typeof render> {
  return render(
    <SignalWireProvider credentialProvider={credentialProvider as never} callKit={callKit}>
      <Probe />
    </SignalWireProvider>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  createPlatform.mockReturnValue({ options: {}, dispose: jest.fn() });
  load.mockReturnValue({ bindClient, trackCall } as never);
});

describe('SignalWireProvider callKit wiring', () => {
  it('does not touch the CallKit bridge when callKit is off', () => {
    renderWith(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('binds the client to the bridge when callKit is on', () => {
    renderWith(true);
    expect(bindClient).toHaveBeenCalledTimes(1);
  });

  it('registers a dialled call with the native UI', async () => {
    renderWith(true);
    await act(async () => {
      await dialFn?.('/public/support');
    });
    expect(trackCall).toHaveBeenCalledWith({ id: 'call-1' }, '/public/support', '/public/support');
  });

  it('does not register dialled calls when callKit is off', async () => {
    renderWith(false);
    await act(async () => {
      await dialFn?.('/public/support');
    });
    expect(trackCall).not.toHaveBeenCalled();
    expect(harness.dial).toHaveBeenCalled();
  });

  it('still returns the call from dial when callKit is on', async () => {
    renderWith(true);
    let call: unknown;
    await act(async () => {
      call = await dialFn?.('/public/support');
    });
    expect(call).toEqual({ id: 'call-1' });
  });
});
