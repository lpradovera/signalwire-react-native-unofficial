/**
 * A call the call-waiting policy refuses never reaches the app's incoming list
 * (BUG-I1).
 *
 * The registry refuses a call over the limit as busy (`reject()`), but the SDK
 * keeps it in `incomingCalls` with status `ringing` until the reject request
 * completes. `useIncomingCalls()` listed it for that moment, so the in-app
 * sheet flashed Hold & Accept / End & Accept for a call that was already
 * being turned down (under 0.5 s on the iPhone and the emulator). The hook now
 * asks the observer, and the CallKit observer answers from the registry.
 *
 * The real bridge singleton, the real observer and the real hook; the SDK's
 * list is delivered as the SDK delivers it (observeOn(asapScheduler)), and the
 * hook subscribes before the bridge does, the order that lost the race.
 */
import { act, render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';
import { asapScheduler, BehaviorSubject, observeOn } from 'rxjs';

import { SignalWireContext, useIncomingCalls } from '@signalwire/react';

import { resetAudioRouteControllerForTesting } from '../audio/AudioRouteController';
import { getCallKit, resetCallKitForTesting } from './CallKeepBridge';
import { createCallKitObserver } from './observer';

import type { CallWaitingMode } from './callWaitingMode';

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return Object.defineProperty(actual, 'Platform', {
    value: { ...actual.Platform, OS: 'android', Version: 35, select: (o: Record<string, unknown>) => o.android }
  });
});

function sdkCall(id: string, direction: 'inbound' | 'outbound', status: string) {
  const status$ = new BehaviorSubject(status);
  return {
    id,
    direction,
    from: `+1555000${id}`,
    fromName: `Caller ${id}`,
    status$,
    get status() {
      return status$.value;
    },
    answer: jest.fn(),
    // The status leaves 'ringing' only once the bye completes: never, here.
    reject: jest.fn(),
    hangup: jest.fn(async () => undefined)
  };
}

type FakeCall = ReturnType<typeof sdkCall>;

/** Every list the hook rendered, as call ids. */
let rendered: string[][] = [];

function Probe(): React.JSX.Element {
  const { calls } = useIncomingCalls();
  rendered.push(calls.map((call) => call.id));
  return <Text testID="count">{calls.length}</Text>;
}

describe.each([
  ['single', 1],
  ['endAndAccept', 2],
  ['full', 2]
] as Array<[CallWaitingMode, number]>)("an incoming call refused as busy in '%s'", (mode, limit) => {
  const subject = new BehaviorSubject<FakeCall[]>([]);
  const client = {
    isConnected$: new BehaviorSubject(true),
    session: {
      // A new wrapper per read, delivered on the asap scheduler, as the SDK does.
      get incomingCalls$() {
        return subject.asObservable().pipe(observeOn(asapScheduler));
      },
      get incomingCalls() {
        return subject.value;
      }
    }
  };

  let unbind: () => void = () => undefined;

  beforeEach(async () => {
    rendered = [];
    subject.next([]);
    await getCallKit().setup({ appName: 'Demo', callWaiting: mode });
  });

  afterEach(() => {
    unbind();
    resetCallKitForTesting();
    resetAudioRouteControllerForTesting();
  });

  async function mount(): Promise<void> {
    const observer = createCallKitObserver();
    await render(
      <SignalWireContext.Provider value={{ client: client as never, error: null, observer }}>
        <Probe />
      </SignalWireContext.Provider>
    );
    // After the hook has subscribed: the bridge sees each list second.
    unbind = observer.bindClient?.(client as never) ?? (() => undefined);
  }

  it('is never listed by useIncomingCalls, not even while its decline is in flight', async () => {
    await mount();
    const bridge = getCallKit();
    bridge.trackCall(sdkCall('live', 'outbound', 'connected') as never, '/private/live', 'Live');
    // At a limit of two, a second call is waiting already: the third is refused.
    const waiting = limit > 1 ? [sdkCall('waiting', 'inbound', 'ringing')] : [];
    const refused = sdkCall('refused', 'inbound', 'ringing');

    await act(async () => {
      subject.next(waiting);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      subject.next([...waiting, refused]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(refused.reject).toHaveBeenCalledTimes(1);
    // Still ringing in the SDK: only the filter keeps it off the list.
    expect(refused.status).toBe('ringing');
    expect(bridge.isIncomingRefused(refused as never)).toBe(true);
    expect(rendered.flat()).not.toContain('refused');
    expect(rendered[rendered.length - 1]).toEqual(waiting.map((call) => call.id));
  });

  it('still lists a call the policy lets ring', async () => {
    await mount();
    const bridge = getCallKit();
    if (limit > 1) {
      bridge.trackCall(sdkCall('live', 'outbound', 'connected') as never, '/private/live', 'Live');
    }
    const ringing = sdkCall('ringing', 'inbound', 'ringing');

    await act(async () => {
      subject.next([ringing]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(ringing.reject).not.toHaveBeenCalled();
    expect(bridge.isIncomingRefused(ringing as never)).toBe(false);
    expect(rendered[rendered.length - 1]).toEqual(['ringing']);
  });
});
