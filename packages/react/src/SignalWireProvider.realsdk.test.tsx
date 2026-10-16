/**
 * The provider and hooks against the REAL @signalwire/js client, talking to
 * an in-process fake server (see jest/realSdk.ts). The unit tests' fakes
 * hide what these check: the real destroy() throws until connect() has built
 * a session, the session appears only at the end of connect(), and
 * disconnect() does not come back by itself.
 */
import { act, render, screen } from '@testing-library/react';
import React, { useContext } from 'react';

import { installFakeFetch, options, quietSdk, server, tick, token } from '../jest/realSdk';
import { SignalWireContext, SignalWireProvider } from './SignalWireProvider';
import { useIncomingCalls } from './useIncomingCalls';
import { useSignalWire } from './useSignalWire';

jest.mock('@signalwire/js', () => jest.requireActual('../jest/realSdk').sdk);

let state: ReturnType<typeof useSignalWire> | undefined;
function Status(): React.JSX.Element {
  state = useSignalWire();
  return <span data-testid="connected">{String(state.isConnected)}</span>;
}

async function waitUntil(condition: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end && !condition()) {
    await act(async () => {
      await tick(20);
    });
  }
  return condition();
}

const settle = (ms: number): Promise<void> =>
  act(async () => {
    await tick(ms);
  });

const credentials = () => ({ authenticate: jest.fn(async () => ({ token })) });

beforeAll(() => {
  quietSdk();
  installFakeFetch();
});
beforeEach(() => {
  server.reset();
  state = undefined;
});
afterEach(() => server.reset());

describe('client lifecycle', () => {
  it('connects, registers, and closes its socket on unmount', async () => {
    const view = render(
      <SignalWireProvider credentialProvider={credentials()} options={options}>
        <Status />
      </SignalWireProvider>
    );
    expect(await waitUntil(() => server.count('subscriber.online') === 1)).toBe(true);
    expect(state?.isConnected).toBe(true);

    view.unmount();
    await settle(50);
    expect(server.open()).toHaveLength(0);
  });

  it('StrictMode: the client it discards never authenticates, connects or registers', async () => {
    const provider = credentials();
    const view = render(
      <React.StrictMode>
        <SignalWireProvider credentialProvider={provider} options={options}>
          <Status />
        </SignalWireProvider>
      </React.StrictMode>
    );
    expect(await waitUntil(() => state?.isConnected === true)).toBe(true);
    await settle(300);

    expect(provider.authenticate).toHaveBeenCalledTimes(1);
    expect(server.sockets).toHaveLength(1);
    expect(server.count('subscriber.online')).toBe(1);

    view.unmount();
    await settle(50);
    expect(server.open()).toHaveLength(0);
  });

  it('a client unmounted while it is still starting closes its socket and stays closed', async () => {
    // Hold the profile fetch, the step between authenticate and connect.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = globalThis.fetch as jest.Mock;
    const serve = fetch.getMockImplementation()!;
    const fetched = fetch.mock.calls.length;
    fetch.mockImplementationOnce(async (...args: unknown[]) => {
      await held;
      return serve(...args);
    });

    const provider = credentials();
    const view = render(
      <SignalWireProvider credentialProvider={provider} options={options}>
        <Status />
      </SignalWireProvider>
    );
    expect(await waitUntil(() => fetch.mock.calls.length === fetched + 1)).toBe(true);
    view.unmount();
    release();
    await settle(500);

    // Past authenticate it cannot be stopped short of connecting (the SDK
    // throws for a request on a destroyed transport, so it is destroyed once
    // its startup has registered), but it closes its socket and stays closed.
    expect(server.sockets).toHaveLength(1);
    expect(server.open()).toHaveLength(0);
    await settle(1000);
    expect(server.sockets).toHaveLength(1);
  });

  it('a new credentialProvider builds one new client and leaves no other socket open', async () => {
    function App({ provider }: { provider: ReturnType<typeof credentials> }) {
      return (
        <SignalWireProvider credentialProvider={provider} options={options}>
          <Status />
        </SignalWireProvider>
      );
    }
    const view = render(<App provider={credentials()} />);
    expect(await waitUntil(() => server.count('subscriber.online') === 1)).toBe(true);
    view.rerender(<App provider={credentials()} />);
    expect(await waitUntil(() => server.count('subscriber.online') === 2)).toBe(true);
    await settle(100);
    expect(server.open()).toHaveLength(1);
    view.unmount();
  });
});

describe('disconnect and connect', () => {
  it('connect() brings a disconnected client back', async () => {
    const view = render(
      <SignalWireProvider credentialProvider={credentials()} options={options}>
        <Status />
      </SignalWireProvider>
    );
    expect(await waitUntil(() => state?.isConnected === true)).toBe(true);

    await act(async () => {
      await state!.disconnect();
    });
    await settle(100);
    expect(state!.isConnected).toBe(false);
    expect(server.open()).toHaveLength(0);

    await act(async () => {
      await state!.connect();
    });
    expect(await waitUntil(() => state?.isConnected === true)).toBe(true);
    expect(server.open()).toHaveLength(1);
    // Registered again, so inbound calls reach it.
    expect(await waitUntil(() => server.count('subscriber.online') === 2)).toBe(true);

    view.unmount();
    await settle(50);
    expect(server.open()).toHaveLength(0);
  });
});

describe('useIncomingCalls', () => {
  function IncomingOnly(): React.JSX.Element {
    const { calls } = useIncomingCalls();
    return <span data-testid="incoming">{String(calls.length)}</span>;
  }

  /** What ClientSessionManager does with an inbound invite once it has built the call. */
  function deliverInbound(client: unknown, id: string): void {
    const session = (client as { _clientSession: { _calls$: { next(v: unknown): void } } })
      ._clientSession;
    session._calls$.next({ [id]: { id, direction: 'inbound', from: '+15550001' } });
  }

  it('shows an inbound call in a component that uses nothing else', async () => {
    let client: { isConnected: boolean } | null | undefined;
    // Reads the context only: it re-renders when the client is set, not when
    // the client connects, like IncomingOnly.
    function Grab(): null {
      client = useContext(SignalWireContext)?.client as never;
      return null;
    }
    const view = render(
      <SignalWireProvider credentialProvider={credentials()} options={options}>
        <Grab />
        <IncomingOnly />
      </SignalWireProvider>
    );
    expect(await waitUntil(() => client?.isConnected === true)).toBe(true);

    await act(async () => {
      deliverInbound(client, 'inbound-1');
      await tick(20);
    });

    expect(screen.getByTestId('incoming').textContent).toBe('1');
    view.unmount();
  });

  it('follows the new session after disconnect() and connect()', async () => {
    let client: { isConnected: boolean; connect(): Promise<void>; disconnect(): Promise<void> } | undefined;
    function Grab(): null {
      client = useContext(SignalWireContext)?.client as never;
      return null;
    }
    const view = render(
      <SignalWireProvider credentialProvider={credentials()} options={options}>
        <Grab />
        <IncomingOnly />
      </SignalWireProvider>
    );
    expect(await waitUntil(() => client?.isConnected === true)).toBe(true);
    await act(async () => {
      await client!.disconnect();
      await client!.connect();
    });
    expect(await waitUntil(() => client?.isConnected === true)).toBe(true);

    await act(async () => {
      deliverInbound(client, 'inbound-2');
      await tick(20);
    });

    expect(screen.getByTestId('incoming').textContent).toBe('1');
    view.unmount();
  });
});
