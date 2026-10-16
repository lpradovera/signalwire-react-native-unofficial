import { act, render, screen } from '@testing-library/react';
import React, { useContext } from 'react';
import { BehaviorSubject, Subject } from 'rxjs';

import { SignalWireContext, SignalWireProvider } from './SignalWireProvider';
import { TokenFetchError } from './tokenSource';
import { useSignalWire } from './useSignalWire';

import type { FetchToken } from './tokenSource';
import type { SignalWirePlatform } from './types';
import type { CredentialProvider } from '@signalwire/js';

const harness = {
  destroy: jest.fn(),
  isConnected$: new BehaviorSubject(false),
  isRegistered$: new BehaviorSubject(false),
  user$: new BehaviorSubject(undefined),
  directory$: new BehaviorSubject(undefined),
  errors$: new Subject<Error>()
};

const constructed: CredentialProvider[] = [];
const constructedOptions: Array<Record<string, unknown> | undefined> = [];

jest.mock('@signalwire/js', () => ({
  SignalWire: jest.fn(function SignalWireMock(
    credentialProvider: CredentialProvider,
    options?: Record<string, unknown>
  ) {
    constructed.push(credentialProvider);
    constructedOptions.push(options);
    return harness;
  }),
  getLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() })
}));

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  });
}

function StatusProbe(): React.JSX.Element {
  const { tokenStatus, error } = useSignalWire();
  return (
    <>
      <span data-testid="token">{tokenStatus ? tokenStatus.state : 'none'}</span>
      <span data-testid="error">{error ? error.message : ''}</span>
    </>
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  jest.clearAllMocks();
  constructed.length = 0;
  constructedOptions.length = 0;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('SignalWireProvider fetchToken', () => {
  it('connects with the fetched token and wires refresh() to the same source', async () => {
    let n = 0;
    const fetchToken: FetchToken = jest.fn(async () => {
      n += 1;
      return { token: `jwt-${n}`, expiresAt: NOW / 1000 + 3600 };
    });

    render(
      <SignalWireProvider fetchToken={fetchToken}>
        <StatusProbe />
      </SignalWireProvider>
    );

    expect(constructed).toHaveLength(1);
    const provider = constructed[0]!;
    await act(async () => {
      await expect(provider.authenticate()).resolves.toEqual({
        token: 'jwt-1',
        expiry_at: NOW + 3_600_000
      });
    });
    expect(screen.getByTestId('token').textContent).toBe('ready');
    await act(async () => {
      await expect(provider.refresh?.()).resolves.toMatchObject({ token: 'jwt-2' });
    });
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it('reports no token status for an app that passes a credentialProvider', () => {
    const credentialProvider = { authenticate: jest.fn(async () => ({ token: 'plain' })) };
    render(
      <SignalWireProvider credentialProvider={credentialProvider}>
        <StatusProbe />
      </SignalWireProvider>
    );
    expect(constructed[0]).toBe(credentialProvider);
    expect(screen.getByTestId('token').textContent).toBe('none');
  });

  it('shows a 401 as the provider error and an unauthorized token status', async () => {
    const fetchToken: FetchToken = async () => {
      throw new TokenFetchError('Session expired', { status: 401 });
    };
    render(
      <SignalWireProvider fetchToken={fetchToken}>
        <StatusProbe />
      </SignalWireProvider>
    );

    await act(async () => {
      await expect(constructed[0]!.authenticate()).rejects.toThrow('Session expired');
    });
    expect(screen.getByTestId('token').textContent).toBe('unauthorized');
    expect(screen.getByTestId('error').textContent).toBe('Session expired');
  });

  it('renews on foreground when the token is near its expiry', async () => {
    let foreground: (() => void) | undefined;
    const stopWatching = jest.fn();
    const platform: SignalWirePlatform = {
      options: {},
      dispose: jest.fn(),
      watchForeground: (listener) => {
        foreground = listener;
        return stopWatching;
      }
    };
    const fetchToken = jest.fn(async () => ({ token: 'jwt', expiresAt: Date.now() + 600_000 }));

    const view = render(
      <SignalWireProvider fetchToken={fetchToken} platform={platform}>
        <StatusProbe />
      </SignalWireProvider>
    );
    await act(async () => {
      await constructed[0]!.authenticate();
    });

    act(() => foreground?.());
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(1);

    // Suspended: the clock moved on, the renewal timer did not run.
    jest.setSystemTime(NOW + 590_000);
    act(() => foreground?.());
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(2);

    view.unmount();
    expect(stopWatching).toHaveBeenCalled();
  });

  it('falls back to the document becoming visible on the web', async () => {
    const fetchToken = jest.fn(async () => ({ token: 'jwt', expiresAt: Date.now() + 600_000 }));
    render(
      <SignalWireProvider fetchToken={fetchToken}>
        <StatusProbe />
      </SignalWireProvider>
    );
    await act(async () => {
      await constructed[0]!.authenticate();
    });

    jest.setSystemTime(NOW + 590_000);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it('exposes renewTokenIfDue for push wake-ups', async () => {
    const fetchToken = jest.fn(async () => ({ token: 'jwt', expiresAt: Date.now() + 600_000 }));
    let renew: (() => void) | undefined;
    function RenewProbe(): null {
      renew = useContext(SignalWireContext)?.renewTokenIfDue;
      return null;
    }
    render(
      <SignalWireProvider fetchToken={fetchToken}>
        <RenewProbe />
      </SignalWireProvider>
    );
    await act(async () => {
      await constructed[0]!.authenticate();
    });

    jest.setSystemTime(NOW + 599_000);
    act(() => renew?.());
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it('stops renewing once unmounted', async () => {
    const fetchToken = jest.fn(async () => ({ token: 'jwt', expiresAt: Date.now() + 120_000 }));
    const view = render(
      <SignalWireProvider fetchToken={fetchToken}>
        <StatusProbe />
      </SignalWireProvider>
    );
    await act(async () => {
      await constructed[0]!.authenticate();
    });
    view.unmount();
    jest.advanceTimersByTime(600_000);
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it('throws when given neither a credentialProvider nor a fetchToken', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      render(
        <SignalWireProvider>
          <StatusProbe />
        </SignalWireProvider>
      )
    ).toThrow(/credentialProvider or fetchToken/);
    consoleError.mockRestore();
  });
});

/*
 * Resume with an expired token: the SDK reconnects the socket that died while
 * the app was suspended with the token it still holds, and the server refuses
 * it before any refresh runs. With fetchToken the client's WebSocket waits for
 * the SDK to hold a fresh token before it opens.
 */
describe('SignalWireProvider fetchToken, reconnecting after the token expired', () => {
  class FakeSocket {
    static created: string[] = [];
    readyState = 0;
    constructor(url: string) {
      FakeSocket.created.push(url);
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    send(): void {}
    close(): void {}
  }

  const realWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  beforeEach(() => {
    FakeSocket.created = [];
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;
  });
  afterEach(() => {
    (globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket;
  });

  it('holds the socket until the SDK has taken a token fetched after the expiry', async () => {
    let n = 0;
    const fetchToken: FetchToken = jest.fn(async () => {
      n += 1;
      return { token: `jwt-${n}`, expiresAt: Date.now() + 120_000 };
    });
    render(
      <SignalWireProvider fetchToken={fetchToken}>
        <StatusProbe />
      </SignalWireProvider>
    );
    const Socket = constructedOptions[0]?.webSocketConstructor as (new (url: string) => unknown) | undefined;
    expect(Socket).toBeDefined();
    const provider = constructed[0]!;
    await act(async () => {
      await provider.authenticate();
    });

    // The first connect is not held.
    new Socket!('wss://relay.example/first');
    await flush();
    expect(FakeSocket.created).toEqual(['wss://relay.example/first']);

    // Suspended past the expiry; the SDK reconnects on resume.
    jest.setSystemTime(NOW + 300_000);
    new Socket!('wss://relay.example/resume');
    await flush();
    expect(FakeSocket.created).toEqual(['wss://relay.example/first']);
    expect(fetchToken).toHaveBeenCalledTimes(2);

    // The SDK's resume refresh takes the new token; then the socket opens.
    await act(async () => {
      await expect(provider.refresh!()).resolves.toMatchObject({ token: 'jwt-2' });
    });
    await act(async () => {
      jest.advanceTimersByTime(0);
    });
    await flush();
    expect(FakeSocket.created).toEqual(['wss://relay.example/first', 'wss://relay.example/resume']);
  });

  it('wraps a webSocketConstructor the app passed, not the global one', async () => {
    const appSocket = jest.fn(function AppSocket(this: Record<string, unknown>) {
      this.readyState = 0;
      this.addEventListener = () => undefined;
    });
    render(
      <SignalWireProvider
        fetchToken={jest.fn(async () => ({ token: 'jwt' }))}
        options={{ webSocketConstructor: appSocket as never }}
      >
        <StatusProbe />
      </SignalWireProvider>
    );
    const Socket = constructedOptions[0]?.webSocketConstructor as new (url: string) => unknown;
    expect(Socket).not.toBe(appSocket);
    new Socket('wss://relay.example/app');
    await flush();
    expect(appSocket).toHaveBeenCalledWith('wss://relay.example/app');
    expect(FakeSocket.created).toEqual([]);
  });

  it('leaves the WebSocket alone with a credentialProvider', () => {
    render(
      <SignalWireProvider credentialProvider={{ authenticate: async () => ({ token: 't' }) }}>
        <StatusProbe />
      </SignalWireProvider>
    );
    expect(constructedOptions[0]?.webSocketConstructor).toBeUndefined();
  });
});
