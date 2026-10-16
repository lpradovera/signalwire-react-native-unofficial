/**
 * `error` is the SDK's last error since the client last became ready.
 *
 * The SDK reports transient, self-healing failures on errors$ (every
 * WebSocket 'error' event, a connect timeout, a register retry) and then
 * reconnects by itself. Kept until the client was rebuilt, the first of them
 * showed as a current failure under "Connected as ..." for the whole session.
 */
import { act, render, screen } from '@testing-library/react';
import React from 'react';
import { BehaviorSubject, Subject } from 'rxjs';

import { SignalWireProvider } from './SignalWireProvider';
import { useSignalWire } from './useSignalWire';

const harness = {
  destroy: jest.fn(),
  isConnected$: new BehaviorSubject(false),
  isRegistered$: new BehaviorSubject(false),
  user$: new BehaviorSubject(undefined),
  directory$: new BehaviorSubject(undefined),
  ready$: new BehaviorSubject(false),
  errors$: new Subject<Error>()
};

jest.mock('@signalwire/js', () => ({
  SignalWire: jest.fn(function SignalWireMock() {
    return harness;
  }),
  getLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() })
}));

const credentialProvider = { authenticate: jest.fn(async () => ({ token: 't' })) };

function Probe(): React.JSX.Element {
  const { error } = useSignalWire();
  return <span data-testid="error">{error ? error.message : 'none'}</span>;
}

function renderProvider(): void {
  render(
    <SignalWireProvider credentialProvider={credentialProvider as never}>
      <Probe />
    </SignalWireProvider>
  );
}

beforeEach(() => {
  harness.isConnected$.next(false);
  harness.ready$.next(false);
});

describe('SignalWireProvider error', () => {
  it('clears a socket error once the client reconnects', async () => {
    renderProvider();
    await act(async () => harness.ready$.next(true));

    // A network drop: the socket errors, the SDK reconnects by itself and
    // authenticates again. isConnected$ stays true throughout.
    await act(async () => {
      harness.ready$.next(false);
      harness.errors$.next(new Error('WebSocket connection error'));
    });
    expect(screen.getByTestId('error').textContent).toBe('WebSocket connection error');

    await act(async () => harness.ready$.next(true));
    expect(screen.getByTestId('error').textContent).toBe('none');
  });

  it('clears a connect failure once the first connection succeeds', async () => {
    renderProvider();
    await act(async () => harness.errors$.next(new Error('Connection timeout')));

    await act(async () => harness.ready$.next(true));

    expect(screen.getByTestId('error').textContent).toBe('none');
  });

  it('keeps an error raised while the client is ready', async () => {
    // A failure after the connection is up (re-registration, a device) is
    // current, and nothing has fixed it yet.
    renderProvider();
    await act(async () => harness.ready$.next(true));

    await act(async () => harness.errors$.next(new Error('Re-registration failed')));

    expect(screen.getByTestId('error').textContent).toBe('Re-registration failed');
  });
});
