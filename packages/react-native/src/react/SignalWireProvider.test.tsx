import { act, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

// Everything the mock needs is built *inside* the factory. A factory that
// closes over outer `const`s reads them before their initializers have run.
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

  const SignalWire = jest.fn(function SignalWireMock() {
    return harness;
  });

  return {
    SignalWire,
    getLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
    __harness: harness
  };
});

jest.mock('../platform/createReactNativePlatform');

import * as sdk from '@signalwire/js';

import { createReactNativePlatform } from '../platform/createReactNativePlatform';
import { SignalWireContext, SignalWireProvider } from './SignalWireProvider';
import { useSignalWire } from './useSignalWire';

import type { BehaviorSubject, Subject } from 'rxjs';

interface Harness {
  destroy: jest.Mock;
  dial: jest.Mock;
  isConnected$: BehaviorSubject<boolean>;
  errors$: Subject<Error>;
}

const harness = (sdk as unknown as { __harness: Harness }).__harness;
const SignalWireMock = sdk.SignalWire as unknown as jest.Mock;
const createPlatform = createReactNativePlatform as jest.MockedFunction<
  typeof createReactNativePlatform
>;
const dispose = jest.fn();

const credentialProvider = { authenticate: jest.fn(async () => ({ token: 't' })) };

function Probe(): React.JSX.Element {
  const { isConnected, error } = useSignalWire();
  return <Text testID="state">{error ? `error:${error.message}` : String(isConnected)}</Text>;
}

function renderProvider(): ReturnType<typeof render> {
  return render(
    <SignalWireProvider credentialProvider={credentialProvider as never}>
      <Probe />
    </SignalWireProvider>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  harness.isConnected$.next(false);
  createPlatform.mockReturnValue({ options: { skipDeviceMonitoring: true }, dispose });
});

describe('SignalWireProvider', () => {
  it('constructs SignalWire once with the platform options merged in', () => {
    renderProvider();
    expect(SignalWireMock).toHaveBeenCalledTimes(1);
    expect(SignalWireMock.mock.calls[0]?.[1]).toMatchObject({ skipDeviceMonitoring: true });
  });

  it('exposes connection state from the client observables', async () => {
    const { getByTestId } = renderProvider();
    await act(async () => {
      harness.isConnected$.next(true);
    });
    await waitFor(() => expect(getByTestId('state').props.children).toBe('true'));
  });

  it('surfaces errors$ as error state', async () => {
    const { getByTestId } = renderProvider();
    await act(async () => {
      harness.errors$.next(new Error('auth failed'));
    });
    await waitFor(() => expect(getByTestId('state').props.children).toBe('error:auth failed'));
  });

  it('destroys the client and disposes the platform on unmount, in that order', () => {
    const order: string[] = [];
    harness.destroy.mockImplementation(() => order.push('destroy'));
    dispose.mockImplementation(() => order.push('dispose'));

    renderProvider().unmount();

    expect(order).toEqual(['destroy', 'dispose']);
  });

  it('passes platform options through to createReactNativePlatform', () => {
    render(
      <SignalWireProvider
        credentialProvider={credentialProvider as never}
        platform={{ netInfo: false }}
      >
        <Probe />
      </SignalWireProvider>
    );
    expect(createPlatform).toHaveBeenCalledWith({ netInfo: false });
  });

  it('lets caller options override the platform defaults', () => {
    render(
      <SignalWireProvider
        credentialProvider={credentialProvider as never}
        options={{ skipDeviceMonitoring: false }}
      >
        <Probe />
      </SignalWireProvider>
    );
    expect(SignalWireMock.mock.calls[0]?.[1]).toMatchObject({ skipDeviceMonitoring: false });
  });
});

describe('useSignalWire outside a provider', () => {
  it('throws a message naming the provider', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow(/SignalWireProvider/);
    consoleError.mockRestore();
  });
});

describe('useSignalWire.dial', () => {
  let dialFn: ((destination: string) => Promise<unknown>) | undefined;

  function DialProbe(): React.JSX.Element {
    dialFn = useSignalWire().dial;
    return <Text>ok</Text>;
  }

  it('delegates to the client', async () => {
    render(
      <SignalWireProvider credentialProvider={credentialProvider as never}>
        <DialProbe />
      </SignalWireProvider>
    );
    await act(async () => {
      await dialFn?.('/public/room');
    });
    expect(harness.dial).toHaveBeenCalledWith('/public/room', undefined);
  });

  it('rejects before the client is ready', async () => {
    render(
      <SignalWireContext.Provider value={{ client: null, error: null, callKitEnabled: false }}>
        <DialProbe />
      </SignalWireContext.Provider>
    );
    await expect(dialFn?.('/public/room')).rejects.toThrow(/not ready/);
  });
});
