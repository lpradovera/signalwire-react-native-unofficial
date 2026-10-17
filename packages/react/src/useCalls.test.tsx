import { act, render } from '@testing-library/react';
import React from 'react';
import { BehaviorSubject } from 'rxjs';

import { resetCallHoldStateForTesting } from './callHold';
import { SignalWireContext } from './SignalWireProvider';
import { useCalls } from './useCalls';
import { useIncomingCalls } from './useIncomingCalls';
import { useSignalWire } from './useSignalWire';

import type { UseCallsResult } from './useCalls';
import type { UseIncomingCallsResult } from './useIncomingCalls';
import type { UseSignalWireResult } from './useSignalWire';
import type { CallObserver } from './types';

jest.mock('@signalwire/js', () => ({
  getLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() })
}));

const order: string[] = [];

function sdkCall(id: string, direction: 'inbound' | 'outbound', status = 'connected') {
  const status$ = new BehaviorSubject(status);
  const call = {
    id,
    direction,
    status$,
    get status() {
      return status$.value;
    },
    _holdState: false,
    toggleHold: jest.fn(async () => {
      order.push(`${call._holdState ? 'unhold' : 'hold'} ${id}`);
      call._holdState = !call._holdState;
    }),
    answer: jest.fn(async () => {
      order.push(`answer ${id}`);
      status$.next('connected');
    }),
    hangup: jest.fn(async () => {
      order.push(`hangup ${id}`);
      status$.next('destroyed');
    }),
    reject: jest.fn(async () => undefined)
  };
  return call;
}

type FakeCall = ReturnType<typeof sdkCall>;

function fakeClient() {
  const calls$ = new BehaviorSubject<FakeCall[]>([]);
  return {
    calls$,
    session: {
      calls$,
      get calls() {
        return calls$.value;
      },
      incomingCalls$: calls$,
      get incomingCalls() {
        return calls$.value.filter((call) => call.direction === 'inbound');
      }
    },
    isConnected$: new BehaviorSubject(true),
    isConnected: true,
    isRegistered$: new BehaviorSubject(true),
    user$: new BehaviorSubject(undefined),
    directory$: new BehaviorSubject(undefined),
    dial: jest.fn(async (destination: string) => {
      order.push(`dial ${destination}`);
      const call = sdkCall(destination, 'outbound', 'connecting');
      calls$.next([...calls$.value, call]);
      return call;
    })
  };
}

let calls: UseCallsResult;
let incoming: UseIncomingCallsResult;
let signalwire: UseSignalWireResult;

function Probe(): null {
  calls = useCalls();
  incoming = useIncomingCalls();
  signalwire = useSignalWire();
  return null;
}

function mount(client: ReturnType<typeof fakeClient>, observer?: CallObserver) {
  return render(
    <SignalWireContext.Provider value={{ client: client as never, error: null, observer }}>
      <Probe />
    </SignalWireContext.Provider>
  );
}

beforeEach(() => {
  order.length = 0;
  resetCallHoldStateForTesting();
});

describe('useCalls', () => {
  it('lists calls in progress, without a ringing inbound call or an ended one', async () => {
    const client = fakeClient();
    const a = sdkCall('a', 'outbound');
    const ringing = sdkCall('b', 'inbound', 'ringing');
    const gone = sdkCall('c', 'outbound', 'destroyed');
    client.calls$.next([a, ringing, gone]);
    mount(client);
    await act(async () => undefined);

    expect(calls.calls).toEqual([a]);
    expect(calls.activeCall).toBe(a);
    expect(calls.heldCalls).toEqual([]);
  });

  it('holds, swaps and resumes, one active call at a time, telling the observer each change', async () => {
    const client = fakeClient();
    const a = sdkCall('a', 'outbound');
    const b = sdkCall('b', 'inbound');
    client.calls$.next([a, b]);
    const observer: CallObserver = { onHoldChange: jest.fn() };
    mount(client, observer);

    await act(async () => calls.hold(a as never));
    expect(calls.activeCall).toBe(b);
    expect(calls.heldCalls).toEqual([a]);

    await act(async () => calls.swap());
    expect(order).toEqual(['hold a', 'hold b', 'unhold a']);
    expect(calls.activeCall).toBe(a);
    expect(calls.heldCalls).toEqual([b]);
    expect((observer.onHoldChange as jest.Mock).mock.calls.map(([call, held]) => `${call.id}:${held}`)).toEqual([
      'a:true',
      'b:true',
      'a:false'
    ]);
  });

  it('unhold() holds the active call first', async () => {
    const client = fakeClient();
    const a = sdkCall('a', 'outbound');
    const b = sdkCall('b', 'outbound');
    client.calls$.next([a, b]);
    mount(client);
    await act(async () => calls.hold(a as never));

    await act(async () => calls.unhold(a as never));
    expect(order).toEqual(['hold a', 'hold b', 'unhold a']);
  });

  it('drops a held call that ends, leaving the other active', async () => {
    const client = fakeClient();
    const a = sdkCall('a', 'outbound');
    const b = sdkCall('b', 'outbound');
    client.calls$.next([a, b]);
    mount(client);
    await act(async () => calls.hold(a as never));

    await act(async () => a.status$.next('destroyed'));
    expect(calls.calls).toEqual([b]);
    expect(calls.heldCalls).toEqual([]);
    expect(calls.activeCall).toBe(b);
  });

  it('swap() does nothing without a held call', async () => {
    const client = fakeClient();
    client.calls$.next([sdkCall('a', 'outbound')]);
    mount(client);
    await act(async () => calls.swap());
    expect(order).toEqual([]);
  });
});

describe('dial() during a call', () => {
  it('holds the active call, then places the new one', async () => {
    const client = fakeClient();
    const a = sdkCall('a', 'outbound');
    client.calls$.next([a]);
    mount(client);

    await act(async () => {
      await signalwire.dial('/private/bob');
    });

    expect(order).toEqual(['hold a', 'dial /private/bob']);
    expect(calls.heldCalls).toEqual([a]);
    expect(calls.activeCall?.id).toBe('/private/bob');
  });

  it('resumes the held call when the new call cannot be placed', async () => {
    const client = fakeClient();
    const a = sdkCall('a', 'outbound');
    client.calls$.next([a]);
    client.dial.mockRejectedValueOnce(new Error('CallCreateError'));
    mount(client);

    await act(async () => {
      await expect(signalwire.dial('/private/bob')).rejects.toThrow('CallCreateError');
    });

    expect(order).toEqual(['hold a', 'unhold a']);
    expect(calls.activeCall).toBe(a);
  });

  it('holds nothing when the observer refuses the dial', async () => {
    const client = fakeClient();
    client.calls$.next([sdkCall('a', 'outbound')]);
    mount(client, {
      beforeOutgoingCall: () => {
        throw new Error('CallInProgressError');
      }
    });

    await act(async () => {
      await expect(signalwire.dial('/private/bob')).rejects.toThrow('CallInProgressError');
    });
    expect(order).toEqual([]);
  });
});

describe('answering during a call', () => {
  it('answer() holds the active call, then answers (Hold & Accept)', async () => {
    const client = fakeClient();
    const a = sdkCall('a', 'outbound');
    const b = sdkCall('b', 'inbound', 'ringing');
    client.calls$.next([a, b]);
    mount(client);

    await act(async () => incoming.answer(b as never));

    expect(order).toEqual(['hold a', 'answer b']);
    expect(calls.activeCall).toBe(b);
    expect(calls.heldCalls).toEqual([a]);
  });

  it('endAndAnswer() hangs the active call up, then answers (End & Accept)', async () => {
    const client = fakeClient();
    const a = sdkCall('a', 'outbound');
    const b = sdkCall('b', 'inbound', 'ringing');
    client.calls$.next([a, b]);
    mount(client);

    await act(async () => incoming.endAndAnswer(b as never));

    expect(order).toEqual(['hangup a', 'answer b']);
    expect(calls.calls).toEqual([b]);
  });

  it('hands the observer which of the two was asked for when it takes over', async () => {
    const client = fakeClient();
    const b = sdkCall('b', 'inbound', 'ringing');
    client.calls$.next([sdkCall('a', 'outbound'), b]);
    const observer: CallObserver = { onIncomingAnswer: jest.fn(() => true) };
    mount(client, observer);

    await act(async () => incoming.answer(b as never));
    await act(async () => incoming.endAndAnswer(b as never));

    expect(observer.onIncomingAnswer).toHaveBeenNthCalledWith(1, b, 'hold');
    expect(observer.onIncomingAnswer).toHaveBeenNthCalledWith(2, b, 'end');
    expect(order).toEqual([]);
  });
});
