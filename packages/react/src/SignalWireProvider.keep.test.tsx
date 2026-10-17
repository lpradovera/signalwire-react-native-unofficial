import { act, render } from '@testing-library/react';
import React, { useContext } from 'react';
import { BehaviorSubject, Subject } from 'rxjs';

import { SignalWireContext, SignalWireProvider } from './SignalWireProvider';

import type { CallObserver, SignalWirePlatform } from './types';

/*
 * Back on Android during a call (decision 16): the activity is destroyed and
 * React Native unmounts the app, but the call goes on in Telecom and the
 * ongoing-call notification brings the app back. With keepCallsOnUnmount the
 * provider keeps the client (and its call) for the provider that mounts next,
 * instead of hanging up.
 */

function liveCall(status = 'connected') {
  const status$ = new BehaviorSubject(status);
  return {
    status$,
    get status() {
      return status$.value;
    },
    hangup: jest.fn(async () => undefined)
  };
}

function client() {
  const calls$ = new BehaviorSubject<ReturnType<typeof liveCall>[]>([]);
  return {
    session: {
      calls$,
      get calls() {
        return calls$.value;
      }
    },
    destroy: jest.fn(),
    isConnected$: new BehaviorSubject(true),
    isRegistered$: new BehaviorSubject(true),
    user$: new BehaviorSubject(undefined),
    directory$: new BehaviorSubject(undefined),
    errors$: new Subject<Error>()
  };
}

let built: ReturnType<typeof client>[] = [];

jest.mock('@signalwire/js', () => ({
  SignalWire: jest.fn(function SignalWireMock() {
    const next = client();
    built.push(next);
    return next;
  }),
  getLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() })
}));

const credentialProvider = { authenticate: jest.fn(async () => ({ token: 't' })) };

let seen: unknown[] = [];
function Probe(): null {
  seen.push(useContext(SignalWireContext)?.client ?? null);
  return null;
}

function platformFactory() {
  const platform: SignalWirePlatform = { options: {}, dispose: jest.fn() };
  platforms.push(platform);
  return platform;
}
let platforms: SignalWirePlatform[] = [];

function mount(keep: boolean, observer?: CallObserver) {
  return render(
    <SignalWireProvider
      credentialProvider={credentialProvider as never}
      platform={platformFactory}
      observer={observer}
      keepCallsOnUnmount={keep}
    >
      <Probe />
    </SignalWireProvider>
  );
}

beforeEach(() => {
  built = [];
  seen = [];
  platforms = [];
  delete (globalThis as Record<string, unknown>).__signalwireReactKeptClient;
});

describe('keepCallsOnUnmount', () => {
  it('keeps the client and its call when unmounted mid-call: no hangup, no destroy', () => {
    const view = mount(true);
    const call = liveCall();
    built[0]!.session.calls$.next([call]);

    view.unmount();

    expect(call.hangup).not.toHaveBeenCalled();
    expect(built[0]!.destroy).not.toHaveBeenCalled();
    expect(platforms[0]!.dispose).not.toHaveBeenCalled();
  });

  it('hands the kept client to the next provider instead of building another', () => {
    const view = mount(true);
    const first = built[0]!;
    first.session.calls$.next([liveCall()]);
    view.unmount();

    seen = [];
    mount(true);

    expect(built).toHaveLength(1);
    expect(seen[seen.length - 1]).toBe(first);
  });

  it('tears the kept client down once its calls have ended with nobody taking it back', async () => {
    const view = mount(true);
    const call = liveCall();
    built[0]!.session.calls$.next([call]);
    view.unmount();

    await act(async () => call.status$.next('destroyed'));

    expect(built[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(platforms[0]!.dispose).toHaveBeenCalledTimes(1);

    // Nothing kept any more: the next provider builds a new client.
    mount(true);
    expect(built).toHaveLength(2);
  });

  it('keeps the observer bound while the client is kept, and unbinds it once taken back', () => {
    const unbind = jest.fn();
    const observer: CallObserver = { bindClient: jest.fn(() => unbind) };
    const view = mount(true, observer);
    built[0]!.session.calls$.next([liveCall()]);

    view.unmount();
    expect(unbind).not.toHaveBeenCalled();

    const again: CallObserver = { bindClient: jest.fn(() => jest.fn()) };
    mount(true, again);
    expect(unbind).toHaveBeenCalledTimes(1);
    expect(again.bindClient).toHaveBeenCalledWith(built[0]);
  });

  it('unbinds the observer when the kept client is torn down', async () => {
    const unbind = jest.fn();
    const view = mount(true, { bindClient: () => unbind });
    const call = liveCall();
    built[0]!.session.calls$.next([call]);
    view.unmount();

    await act(async () => call.status$.next('failed'));
    expect(unbind).toHaveBeenCalledTimes(1);
  });

  it('destroys at once when unmounted with no call in progress', () => {
    const view = mount(true);
    built[0]!.session.calls$.next([liveCall('destroyed')]);
    view.unmount();
    expect(built[0]!.destroy).toHaveBeenCalledTimes(1);
  });

  it('is off by default: unmounting hangs the call up', () => {
    const view = mount(false);
    const call = liveCall();
    built[0]!.session.calls$.next([call]);
    view.unmount();
    expect(call.hangup).toHaveBeenCalledTimes(1);
  });

  it('does not keep a client replaced by new credentials: that ends its calls', () => {
    const view = mount(true);
    const call = liveCall();
    built[0]!.session.calls$.next([call]);

    view.rerender(
      <SignalWireProvider
        credentialProvider={{ authenticate: async () => ({ token: 'other' }) } as never}
        platform={platformFactory}
        keepCallsOnUnmount
      >
        <Probe />
      </SignalWireProvider>
    );

    expect(call.hangup).toHaveBeenCalledTimes(1);
    expect(built).toHaveLength(2);
  });
});
