import { act, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { BehaviorSubject, Subject } from 'rxjs';

import { SignalWireContext, SignalWireProvider } from './SignalWireProvider';
import { useSignalWire } from './useSignalWire';

import type { CallObserver, SignalWirePlatform } from './types';

const harness = {
  destroy: jest.fn(),
  dial: jest.fn(async () => ({ id: 'call-1' })),
  isConnected$: new BehaviorSubject(false),
  isRegistered$: new BehaviorSubject(false),
  user$: new BehaviorSubject(undefined),
  directory$: new BehaviorSubject(undefined),
  errors$: new Subject<Error>()
};

const constructed: Array<{ credentialProvider: unknown; options: unknown }> = [];

jest.mock('@signalwire/js', () => ({
  SignalWire: jest.fn(function SignalWireMock(credentialProvider: unknown, options: unknown) {
    constructed.push({ credentialProvider, options });
    return harness;
  }),
  getLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() })
}));

const credentialProvider = { authenticate: jest.fn(async () => ({ token: 't' })) };

function Probe(): React.JSX.Element {
  const { isConnected, error } = useSignalWire();
  return <span data-testid="state">{error ? `error:${error.message}` : String(isConnected)}</span>;
}

beforeEach(() => {
  jest.clearAllMocks();
  constructed.length = 0;
  harness.isConnected$.next(false);
});

describe('SignalWireProvider on the web — no platform supplied', () => {
  it('constructs the client with only the caller options', () => {
    render(
      <SignalWireProvider credentialProvider={credentialProvider as never}>
        <Probe />
      </SignalWireProvider>
    );

    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.options).toEqual({});
  });

  it('renders connection state without any platform layer', async () => {
    render(
      <SignalWireProvider credentialProvider={credentialProvider as never}>
        <Probe />
      </SignalWireProvider>
    );

    await act(async () => {
      harness.isConnected$.next(true);
    });

    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('true'));
  });

  it('does not throw on unmount when there is nothing to dispose', () => {
    const view = render(
      <SignalWireProvider credentialProvider={credentialProvider as never}>
        <Probe />
      </SignalWireProvider>
    );
    expect(() => view.unmount()).not.toThrow();
    expect(harness.destroy).toHaveBeenCalled();
  });
});

describe('SignalWireProvider with a platform', () => {
  const platform: SignalWirePlatform = {
    options: { skipDeviceMonitoring: true },
    dispose: jest.fn()
  };

  it('merges platform options into the client', () => {
    render(
      <SignalWireProvider credentialProvider={credentialProvider as never} platform={platform}>
        <Probe />
      </SignalWireProvider>
    );
    expect(constructed[0]?.options).toMatchObject({ skipDeviceMonitoring: true });
  });

  it('lets caller options win over the platform', () => {
    render(
      <SignalWireProvider
        credentialProvider={credentialProvider as never}
        platform={platform}
        options={{ skipDeviceMonitoring: false }}
      >
        <Probe />
      </SignalWireProvider>
    );
    expect(constructed[0]?.options).toMatchObject({ skipDeviceMonitoring: false });
  });

  it('destroys the client before disposing the platform', () => {
    const order: string[] = [];
    harness.destroy.mockImplementation(() => order.push('destroy'));
    (platform.dispose as jest.Mock).mockImplementation(() => order.push('dispose'));

    render(
      <SignalWireProvider credentialProvider={credentialProvider as never} platform={platform}>
        <Probe />
      </SignalWireProvider>
    ).unmount();

    // The SDK's teardown may still touch platform globals, so order matters.
    expect(order).toEqual(['destroy', 'dispose']);
  });
});

describe('SignalWireProvider observer wiring', () => {
  it('binds the client to the observer on construction', () => {
    const observer: CallObserver = { bindClient: jest.fn(), onOutgoingCall: jest.fn() };

    render(
      <SignalWireProvider credentialProvider={credentialProvider as never} observer={observer}>
        <Probe />
      </SignalWireProvider>
    );

    expect(observer.bindClient).toHaveBeenCalledWith(harness);
  });

  it('notifies the observer of an outgoing call', async () => {
    const observer: CallObserver = { onOutgoingCall: jest.fn() };
    let dial: ((destination: string) => Promise<unknown>) | undefined;

    function DialProbe(): React.JSX.Element {
      dial = useSignalWire().dial;
      return <span>ok</span>;
    }

    render(
      <SignalWireProvider credentialProvider={credentialProvider as never} observer={observer}>
        <DialProbe />
      </SignalWireProvider>
    );

    await act(async () => {
      await dial?.('/public/room');
    });

    expect(observer.onOutgoingCall).toHaveBeenCalledWith({ id: 'call-1' }, '/public/room');
  });

  it('dials fine with no observer, which is the web case', async () => {
    let dial: ((destination: string) => Promise<unknown>) | undefined;

    function DialProbe(): React.JSX.Element {
      dial = useSignalWire().dial;
      return <span>ok</span>;
    }

    render(
      <SignalWireProvider credentialProvider={credentialProvider as never}>
        <DialProbe />
      </SignalWireProvider>
    );

    await act(async () => {
      await expect(dial?.('/public/room')).resolves.toEqual({ id: 'call-1' });
    });
  });

  it('tolerates an observer that implements neither method', () => {
    expect(() =>
      render(
        <SignalWireProvider credentialProvider={credentialProvider as never} observer={{}}>
          <Probe />
        </SignalWireProvider>
      )
    ).not.toThrow();
  });
});

describe('useSignalWire outside a provider', () => {
  it('throws a message naming the provider', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow(/SignalWireProvider/);
    consoleError.mockRestore();
  });
});

describe('useSignalWire.dial before the client exists', () => {
  it('rejects rather than silently doing nothing', async () => {
    let dial: ((destination: string) => Promise<unknown>) | undefined;

    function DialProbe(): React.JSX.Element {
      dial = useSignalWire().dial;
      return <span>ok</span>;
    }

    render(
      <SignalWireContext.Provider value={{ client: null, error: null, observer: undefined }}>
        <DialProbe />
      </SignalWireContext.Provider>
    );

    await expect(dial?.('/public/room')).rejects.toThrow(/not ready/);
  });
});
