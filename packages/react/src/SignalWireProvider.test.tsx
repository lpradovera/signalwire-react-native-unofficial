import { act, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { BehaviorSubject, Subject } from 'rxjs';

import { SignalWireContext, SignalWireProvider } from './SignalWireProvider';
import { useSignalWire } from './useSignalWire';

import type { CallObserver, SignalWirePlatform } from './types';

const harness = {
  // A started client: destroy() tears it down at once (see destroyClient).
  session: { calls: [] as unknown[] },
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
  harness.session.calls = [];
  constructed.length = 0;
  harness.isConnected$.next(false);
  harness.isRegistered$.next(false);
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

describe('SignalWireProvider platform lifetime', () => {
  function platformLog() {
    const log: string[] = [];
    let built = 0;
    const factory = jest.fn((): SignalWirePlatform => {
      const id = ++built;
      log.push(`build ${id}`);
      return { options: { skipDeviceMonitoring: true }, dispose: () => log.push(`dispose ${id}`) };
    });
    harness.destroy.mockImplementation(() => log.push('destroy'));
    return { log, factory };
  }

  function App({ provider, platform }: { provider: unknown; platform: unknown }) {
    return (
      <SignalWireProvider credentialProvider={provider as never} platform={platform as never}>
        <Probe />
      </SignalWireProvider>
    );
  }

  it('builds a platform from a factory for each client and disposes it after that client', () => {
    const { log, factory } = platformLog();
    const view = render(<App provider={{ ...credentialProvider }} platform={factory} />);
    view.rerender(<App provider={{ ...credentialProvider }} platform={factory} />);
    expect(log).toEqual(['build 1', 'destroy', 'dispose 1', 'build 2']);
    view.unmount();
    expect(log.slice(4)).toEqual(['destroy', 'dispose 2']);
  });

  it('StrictMode: the client that stays mounted gets a live platform', () => {
    const { log, factory } = platformLog();
    const view = render(
      <React.StrictMode>
        <App provider={credentialProvider} platform={factory} />
      </React.StrictMode>
    );
    expect(log).toEqual(['build 1', 'destroy', 'dispose 1', 'build 2']);
    view.unmount();
  });

  it('keeps a platform object across a new credentialProvider, and disposes it on unmount', () => {
    const log: string[] = [];
    harness.destroy.mockImplementation(() => log.push('destroy'));
    const platform = { options: {}, dispose: () => log.push('dispose') };
    const view = render(<App provider={{ ...credentialProvider }} platform={platform} />);
    view.rerender(<App provider={{ ...credentialProvider }} platform={platform} />);
    expect(log).toEqual(['destroy']);
    view.unmount();
    expect(log).toEqual(['destroy', 'destroy', 'dispose']);
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

  it('binds an observer that arrives after the client was built, once', () => {
    // React Native's provider builds its CallKit observer only once callKit is
    // turned on, which can be after mount. Unbound, the observer never mirrors
    // inbound calls into the native UI.
    const tree = (observer?: CallObserver): React.JSX.Element => (
      <SignalWireProvider credentialProvider={credentialProvider as never} observer={observer}>
        <Probe />
      </SignalWireProvider>
    );
    const later: CallObserver = { bindClient: jest.fn() };
    const view = render(tree(undefined));

    view.rerender(tree(later));
    view.rerender(tree(later));

    expect(later.bindClient).toHaveBeenCalledTimes(1);
    expect(later.bindClient).toHaveBeenCalledWith(harness);
  });

  it('does not bind an observer twice when it was there from the start', () => {
    const observer: CallObserver = { bindClient: jest.fn() };
    const tree = (): React.JSX.Element => (
      <SignalWireProvider credentialProvider={credentialProvider as never} observer={observer}>
        <Probe />
      </SignalWireProvider>
    );
    const view = render(tree());
    view.rerender(tree());

    expect(observer.bindClient).toHaveBeenCalledTimes(1);
  });

  it('unbinds an observer when it is replaced or removed', () => {
    // React Native turns its CallKit observer off by passing none. A binding
    // left behind keeps showing every SDK inbound call in CallKit while the
    // app answers it directly: a connected call with no audio.
    const tree = (observer?: CallObserver): React.JSX.Element => (
      <SignalWireProvider credentialProvider={credentialProvider as never} observer={observer}>
        <Probe />
      </SignalWireProvider>
    );
    const unbindFirst = jest.fn();
    const unbindSecond = jest.fn();
    const first: CallObserver = { bindClient: jest.fn(() => unbindFirst) };
    const second: CallObserver = { bindClient: jest.fn(() => unbindSecond) };

    const view = render(tree(first));
    view.rerender(tree(second));
    expect(unbindFirst).toHaveBeenCalledTimes(1);
    expect(second.bindClient).toHaveBeenCalledWith(harness);

    view.rerender(tree(undefined));
    expect(unbindSecond).toHaveBeenCalledTimes(1);
  });

  it('keeps one live binding for an observer re-created on every render', () => {
    let live = 0;
    const make = (): CallObserver => ({
      bindClient: jest.fn(() => {
        live += 1;
        return () => {
          live -= 1;
        };
      })
    });
    const tree = (observer: CallObserver): React.JSX.Element => (
      <SignalWireProvider credentialProvider={credentialProvider as never} observer={observer}>
        <Probe />
      </SignalWireProvider>
    );

    const view = render(tree(make()));
    view.rerender(tree(make()));
    view.rerender(tree(make()));
    view.rerender(tree(make()));

    expect(live).toBe(1);
  });

  it('binds an inline observer that returns no unbind once per client', () => {
    // The 0.1.0 contract: bindClient is called once and returns nothing. Such
    // a binding can't be undone, so binding each render's new observer
    // object stacked one more subscription per render.
    const bindings: unknown[] = [];
    const make = (): CallObserver => ({
      bindClient: (client) => {
        bindings.push(client);
      }
    });
    const tree = (observer: CallObserver, credentials = credentialProvider): React.JSX.Element => (
      <SignalWireProvider credentialProvider={credentials as never} observer={observer}>
        <Probe />
      </SignalWireProvider>
    );

    const view = render(tree(make()));
    view.rerender(tree(make()));
    view.rerender(tree(make()));
    view.rerender(tree(make()));
    expect(bindings).toEqual([harness]);

    // A new client is a new binding.
    view.rerender(tree(make(), { authenticate: jest.fn(async () => ({ token: 'u' })) }));
    expect(bindings).toEqual([harness, harness]);
  });

  it('unbinds the observer when the provider unmounts', () => {
    const unbind = jest.fn();
    const view = render(
      <SignalWireProvider
        credentialProvider={credentialProvider as never}
        observer={{ bindClient: () => unbind }}
      >
        <Probe />
      </SignalWireProvider>
    );

    view.unmount();

    expect(unbind).toHaveBeenCalledTimes(1);
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

  it('lets the observer refuse a dial before the SDK places it', async () => {
    const refusal = new Error('call in progress');
    const observer: CallObserver = {
      beforeOutgoingCall: jest.fn(() => {
        throw refusal;
      }),
      onOutgoingCall: jest.fn()
    };
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
      await expect(dial?.('/public/room')).rejects.toBe(refusal);
    });
    expect(observer.beforeOutgoingCall).toHaveBeenCalledWith('/public/room');
    expect(harness.dial).not.toHaveBeenCalled();
    expect(observer.onOutgoingCall).not.toHaveBeenCalled();
  });

  describe('when onOutgoingCall throws after the SDK placed the call', () => {
    // The SDK has a live call by then; dial() rejects, so the app never gets
    // it and could never hang it up. The leg would stay up on SignalWire.
    function placedCall(status: string) {
      return { id: 'call-1', status, hangup: jest.fn(async () => undefined) };
    }

    async function dialWithThrowingObserver(call: ReturnType<typeof placedCall>) {
      const failure = new Error('native call UI refused');
      harness.dial.mockResolvedValueOnce(call as never);
      const observer: CallObserver = {
        onOutgoingCall: jest.fn(() => {
          throw failure;
        })
      };
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
        await expect(dial?.('/public/room')).rejects.toBe(failure);
      });
    }

    it('hangs the call up and rejects with the observer error', async () => {
      const call = placedCall('connecting');
      await dialWithThrowingObserver(call);
      expect(call.hangup).toHaveBeenCalledTimes(1);
    });

    it.each(['disconnecting', 'disconnected', 'destroyed', 'failed'])(
      'leaves a call that is already %s alone (the observer ended it)',
      async (status) => {
        const call = placedCall(status);
        await dialWithThrowingObserver(call);
        expect(call.hangup).not.toHaveBeenCalled();
      }
    );

    it('still rejects with the observer error when the hangup fails', async () => {
      const call = placedCall('connected');
      call.hangup.mockRejectedValueOnce(new Error('socket closed'));
      await dialWithThrowingObserver(call);
      expect(call.hangup).toHaveBeenCalledTimes(1);
    });
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

/*
 * `error` is the SDK's last error. A dropped WebSocket reports
 * "WebSocket connection error" and the SDK reconnects by itself, but nothing
 * cleared the error, so an app that shows it (the example's banner) said the
 * connection was broken for the rest of the session.
 */
describe('SignalWireProvider error after a reconnect', () => {
  function connectionError(name: string): Error {
    const error = new Error('WebSocket connection error');
    error.name = name;
    return error;
  }

  async function renderConnected(): Promise<void> {
    render(
      <SignalWireProvider credentialProvider={credentialProvider as never}>
        <Probe />
      </SignalWireProvider>
    );
    await act(async () => {
      harness.isConnected$.next(true);
      harness.isRegistered$.next(true);
    });
  }

  it.each(['WebSocketConnectionError', 'WebSocketTimeoutError', 'TransportConnectionError'])(
    'clears a %s once the client registers again',
    async (name) => {
      await renderConnected();
      await act(async () => harness.errors$.next(connectionError(name)));
      expect(screen.getByTestId('state').textContent).toBe('error:WebSocket connection error');

      // The SDK re-registers after its own reconnect.
      await act(async () => harness.isRegistered$.next(true));

      expect(screen.getByTestId('state').textContent).toBe('true');
    }
  );

  it('keeps an error that is not about the connection', async () => {
    await renderConnected();
    await act(async () => harness.errors$.next(new Error('Call creation failed')));

    await act(async () => harness.isRegistered$.next(true));

    expect(screen.getByTestId('state').textContent).toBe('error:Call creation failed');
  });
});

/*
 * A failed dial reports a CallCreateError ("Call creation failed") on
 * errors$ as well as throwing it, and the provider kept it as `error` for the
 * rest of the session: the example's Home screen still said "Call creation
 * failed" after the next call had connected.
 */
describe('SignalWireProvider error after a failed dial', () => {
  function callCreateError(): Error {
    const error = new Error('Call creation failed');
    error.name = 'CallCreateError';
    return error;
  }

  let dialFromProbe: ((to: string) => Promise<unknown>) | undefined;

  function DialProbe(): React.JSX.Element {
    const { dial, error } = useSignalWire();
    dialFromProbe = dial;
    return <span data-testid="state">{error ? `error:${error.message}` : 'none'}</span>;
  }

  async function renderConnected(): Promise<void> {
    render(
      <SignalWireProvider credentialProvider={credentialProvider as never}>
        <DialProbe />
      </SignalWireProvider>
    );
    await act(async () => {
      harness.isConnected$.next(true);
      harness.isRegistered$.next(true);
    });
  }

  it('clears it when the next dial succeeds', async () => {
    await renderConnected();
    await act(async () => harness.errors$.next(callCreateError()));
    expect(screen.getByTestId('state').textContent).toBe('error:Call creation failed');

    await act(async () => {
      await dialFromProbe?.('/public/room');
    });

    expect(screen.getByTestId('state').textContent).toBe('none');
  });

  it('keeps it while the next dial fails too', async () => {
    await renderConnected();
    await act(async () => harness.errors$.next(callCreateError()));
    harness.dial.mockRejectedValueOnce(callCreateError());

    await act(async () => {
      await dialFromProbe?.('/public/room').catch(() => undefined);
    });

    expect(screen.getByTestId('state').textContent).toBe('error:Call creation failed');
  });

  it('clears it once the client registers again (a connect)', async () => {
    await renderConnected();
    await act(async () => harness.errors$.next(callCreateError()));

    await act(async () => harness.isRegistered$.next(true));

    expect(screen.getByTestId('state').textContent).toBe('none');
  });

  it('keeps an error that is not a call error when a dial succeeds', async () => {
    await renderConnected();
    await act(async () => harness.errors$.next(new Error('Device token refresh failed')));

    await act(async () => {
      await dialFromProbe?.('/public/room');
    });

    expect(screen.getByTestId('state').textContent).toBe('error:Device token refresh failed');
  });
});

describe('SignalWireProvider unmounting during a call', () => {
  // The provider unmounts when the app's root goes away: on Android, Back on
  // the root screen destroys the activity and React Native unmounts the tree.
  // Destroying the client closes its socket, so a call still up then could
  // never send its bye and stayed up on SignalWire.
  function liveCall(status = 'connected', hangup: () => Promise<void> = async () => undefined) {
    const status$ = new BehaviorSubject(status);
    return {
      status$,
      get status() {
        return status$.value;
      },
      hangup: jest.fn(hangup)
    };
  }

  function mounted(platform?: SignalWirePlatform) {
    return render(
      <SignalWireProvider credentialProvider={credentialProvider as never} platform={platform}>
        <Probe />
      </SignalWireProvider>
    );
  }

  it('hangs up a live call before destroying the client, then disposes the platform', async () => {
    const order: string[] = [];
    let finishBye: () => void = () => undefined;
    const call = liveCall('connected', () => new Promise<void>((done) => (finishBye = done)));
    call.hangup.mockImplementation(() => {
      order.push('hangup');
      return new Promise<void>((done) => (finishBye = done));
    });
    harness.session.calls = [call];
    harness.destroy.mockImplementation(() => order.push('destroy'));
    const platform = { options: {}, dispose: jest.fn(() => order.push('dispose')) };

    mounted(platform).unmount();
    expect(order).toEqual(['hangup']);

    await act(async () => finishBye());
    expect(order).toEqual(['hangup', 'destroy', 'dispose']);
  });

  it('leaves ended calls alone and destroys at once', () => {
    const ended = liveCall('disconnected');
    harness.session.calls = [ended, liveCall('destroyed'), liveCall('failed')];

    mounted().unmount();

    expect(ended.hangup).not.toHaveBeenCalled();
    expect(harness.destroy).toHaveBeenCalledTimes(1);
  });

  it("waits for a call that is already hanging up, rather than cutting its bye off", async () => {
    const leaving = liveCall('disconnecting');
    harness.session.calls = [leaving];

    mounted().unmount();
    expect(leaving.hangup).not.toHaveBeenCalled();
    expect(harness.destroy).not.toHaveBeenCalled();

    await act(async () => leaving.status$.next('disconnected'));
    expect(harness.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys the client anyway when the hangup never settles', async () => {
    jest.useFakeTimers();
    try {
      harness.session.calls = [liveCall('connected', () => new Promise<void>(() => undefined))];

      mounted().unmount();
      expect(harness.destroy).not.toHaveBeenCalled();

      await act(async () => {
        await jest.advanceTimersByTimeAsync(5000);
      });
      expect(harness.destroy).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('destroys the client when the hangup fails', async () => {
    harness.session.calls = [liveCall('connected', async () => Promise.reject(new Error('gone')))];

    mounted().unmount();
    await act(async () => undefined);

    expect(harness.destroy).toHaveBeenCalledTimes(1);
  });
});
