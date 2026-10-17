/**
 * The Android microphone foreground service for calls outside Telecom
 * (`callKit` off): started while a call is in progress, stopped when none is.
 */
import { logger, SignalWireContext } from '@signalwire/react';
import { act, render } from '@testing-library/react-native';
import React from 'react';
import { NativeModules, Platform, Text } from 'react-native';
import { BehaviorSubject } from 'rxjs';

const mockCalls$ = new BehaviorSubject<unknown[]>([]);

jest.mock('@signalwire/js', () => {
  const { EMPTY } = jest.requireActual('rxjs');
  return {
    // The client the RN provider builds: one session whose calls are mockCalls$.
    SignalWire: class {
      session = {
        calls$: mockCalls$,
        get calls() {
          return mockCalls$.value;
        }
      };
      isConnected$ = new (jest.requireActual('rxjs').BehaviorSubject)(true);
      errors$ = EMPTY;
      destroy(): void {}
    },
    getLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() })
  };
});

import { CallForegroundService } from './CallForegroundService';
import { SignalWireProvider } from './SignalWireProvider';

function sdkCall(id: string, direction: 'inbound' | 'outbound', status: string) {
  const status$ = new BehaviorSubject(status);
  return {
    id,
    direction,
    status$,
    get status() {
      return status$.value;
    },
    // The provider hangs up live calls when it unmounts without callKit.
    hangup: jest.fn(async () => status$.next('destroyed'))
  };
}

type FakeCall = ReturnType<typeof sdkCall>;

const native = { start: jest.fn(), stop: jest.fn() };
let os: jest.ReplaceProperty<typeof Platform.OS> | undefined;

beforeEach(() => {
  native.start.mockReset();
  native.stop.mockReset();
  (NativeModules as Record<string, unknown>).SignalWireCallService = native;
  os = jest.replaceProperty(Platform, 'OS', 'android');
  mockCalls$.next([]);
});

afterEach(() => {
  os?.restore();
  delete (NativeModules as Record<string, unknown>).SignalWireCallService;
});

function contextWith(calls$: BehaviorSubject<FakeCall[]>) {
  return {
    client: {
      session: {
        calls$,
        get calls() {
          return calls$.value;
        }
      },
      isConnected$: new BehaviorSubject(true)
    }
  } as never;
}

async function mount(calls$: BehaviorSubject<FakeCall[]>) {
  return render(
    <SignalWireContext.Provider value={contextWith(calls$)}>
      <CallForegroundService />
    </SignalWireContext.Provider>
  );
}

it('runs the service while a placed call is in progress, and stops it when the call ends', async () => {
  const calls$ = new BehaviorSubject<FakeCall[]>([]);
  await mount(calls$);
  expect(native.start).not.toHaveBeenCalled();
  expect(native.stop).not.toHaveBeenCalled();

  const call = sdkCall('a', 'outbound', 'connecting');
  await act(async () => calls$.next([call]));
  expect(native.start).toHaveBeenCalledTimes(1);

  // Asked again as the call moves on: a start refused before the microphone
  // grant (the first call's permission prompt) is retried once it is granted.
  await act(async () => call.status$.next('connected'));
  expect(native.start).toHaveBeenCalledTimes(2);
  expect(native.stop).not.toHaveBeenCalled();

  await act(async () => call.status$.next('destroyed'));
  expect(native.stop).toHaveBeenCalledTimes(1);
  const starts = native.start.mock.calls.length;

  await act(async () => calls$.next([]));
  expect(native.stop).toHaveBeenCalledTimes(1);
  expect(native.start).toHaveBeenCalledTimes(starts);
});

it('does not take the microphone for an inbound call that is still ringing', async () => {
  const call = sdkCall('b', 'inbound', 'ringing');
  const calls$ = new BehaviorSubject<FakeCall[]>([call]);
  await mount(calls$);
  expect(native.start).not.toHaveBeenCalled();

  await act(async () => call.status$.next('connected'));
  expect(native.start).toHaveBeenCalled();
});

it('keeps running while a held call is left, and stops on unmount', async () => {
  const a = sdkCall('a', 'outbound', 'connected');
  const b = sdkCall('b', 'inbound', 'connected');
  const calls$ = new BehaviorSubject<FakeCall[]>([a, b]);
  const view = await mount(calls$);
  expect(native.start).toHaveBeenCalled();

  await act(async () => b.status$.next('destroyed'));
  expect(native.stop).not.toHaveBeenCalled();

  await view.unmount();
  expect(native.stop).toHaveBeenCalledTimes(1);
});

it('does nothing off Android', async () => {
  os?.restore();
  os = jest.replaceProperty(Platform, 'OS', 'ios');
  await mount(new BehaviorSubject<FakeCall[]>([sdkCall('a', 'outbound', 'connected')]));
  expect(native.start).not.toHaveBeenCalled();
});

it('warns once and carries on when the native module is not linked', async () => {
  delete (NativeModules as Record<string, unknown>).SignalWireCallService;
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const call = sdkCall('a', 'outbound', 'connecting');
  const calls$ = new BehaviorSubject<FakeCall[]>([call]);
  await mount(calls$);
  await act(async () => call.status$.next('connected'));

  const mentions = warn.mock.calls.filter((args) => String(args.join(' ')).includes('SignalWireCallService'));
  expect(mentions).toHaveLength(1);
  warn.mockRestore();
});

describe('SignalWireProvider', () => {
  const credentials = { authenticate: async () => ({ token: 't' }) };
  const tree = (callKit: boolean) => (
    <SignalWireProvider credentialProvider={credentials} callKit={callKit}>
      <Text>child</Text>
    </SignalWireProvider>
  );

  it('runs the service for calls without callKit on Android', async () => {
    mockCalls$.next([sdkCall('a', 'outbound', 'connected')]);
    const view = await render(tree(false));
    expect(native.start).toHaveBeenCalled();
    await view.unmount();
  });

  it('leaves calls under callKit to its ConnectionService', async () => {
    mockCalls$.next([sdkCall('a', 'outbound', 'connected')]);
    const view = await render(tree(true));
    expect(native.start).not.toHaveBeenCalled();
    await view.unmount();
  });
});
