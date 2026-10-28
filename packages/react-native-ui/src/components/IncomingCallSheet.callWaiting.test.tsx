import { act, fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { BehaviorSubject } from 'rxjs';

import { SignalWireContext } from '@signalwire/react';

import { IncomingCallSheet } from './IncomingCallSheet';

/*
 * The sheet over a call in progress (call waiting): Android draws no ringing
 * UI for a self-managed call, so this sheet is the only way to see and take a
 * second call while the call screen is up. It offers what the call-waiting
 * mode allows, as CallKit does on iOS.
 */

let mockMode = 'full';
const mockRingingPushes: Array<{ uuid: string; from?: string; fromName?: string }> = [];
const mockAnswerPush = jest.fn();
const mockRejectPush = jest.fn();
jest.mock('@signalwire/react-native/ringing', () => ({
  displayableName: jest.requireActual('@signalwire/react-native/ringing').displayableName,
  useRingingPushes: () => ({ ringing: mockRingingPushes, answer: mockAnswerPush, reject: mockRejectPush }),
  callWaitingMode: () => mockMode
}));

function call(id: string, direction: 'inbound' | 'outbound', status: string) {
  const status$ = new BehaviorSubject(status);
  return {
    id,
    direction,
    fromName: `Caller ${id}`,
    status$,
    get status() {
      return status$.value;
    },
    _holdState: false,
    toggleHold: jest.fn(async () => undefined),
    answer: jest.fn(async () => undefined),
    reject: jest.fn(async () => undefined),
    hangup: jest.fn(async () => undefined)
  };
}

const calls$ = new BehaviorSubject<ReturnType<typeof call>[]>([]);
const incoming$ = new BehaviorSubject<ReturnType<typeof call>[]>([]);

async function renderSheet(observer?: object, props: Record<string, unknown> = {}): Promise<void> {
  await render(
    <SignalWireContext.Provider
      value={
        {
          client: {
            isConnected$: new BehaviorSubject(true),
            session: {
              calls$,
              get calls() {
                return calls$.value;
              },
              incomingCalls$: incoming$,
              get incomingCalls() {
                return incoming$.value;
              }
            }
          },
          error: null,
          observer
        } as never
      }
    >
      <IncomingCallSheet {...props} />
    </SignalWireContext.Provider>
  );
}

function setCalls(...list: ReturnType<typeof call>[]): void {
  calls$.next(list);
  incoming$.next(list.filter((c) => c.direction === 'inbound'));
}

beforeEach(() => {
  mockMode = 'full';
  mockRingingPushes.length = 0;
  jest.clearAllMocks();
  setCalls();
});

describe('IncomingCallSheet over a call in progress', () => {
  it("offers Hold & Accept, End & Accept and Decline in 'full' mode", async () => {
    setCalls(call('a', 'outbound', 'connected'), call('b', 'inbound', 'ringing'));
    await renderSheet();
    await act(async () => undefined);

    expect(screen.getByTestId('sw-hold-accept')).toBeTruthy();
    expect(screen.getByTestId('sw-end-accept')).toBeTruthy();
    expect(screen.getByTestId('sw-decline')).toBeTruthy();
    expect(screen.queryByTestId('sw-answer')).toBeNull();
  });

  it("offers End & Accept and Decline only in 'endAndAccept' mode", async () => {
    mockMode = 'endAndAccept';
    setCalls(call('a', 'outbound', 'connected'), call('b', 'inbound', 'ringing'));
    await renderSheet();
    await act(async () => undefined);

    expect(screen.queryByTestId('sw-hold-accept')).toBeNull();
    expect(screen.getByTestId('sw-end-accept')).toBeTruthy();
    expect(screen.getByTestId('sw-decline')).toBeTruthy();
  });

  it.each(['single', 'endAndAccept', 'full'])(
    "draws nothing for a call the call-waiting policy refused ('%s'), while its decline is in flight",
    async (mode) => {
      mockMode = mode;
      // Refused as busy: the SDK still lists it, ringing, until the bye completes.
      const refused = call('b', 'inbound', 'ringing');
      setCalls(call('a', 'outbound', 'connected'), refused);
      const observer = { isIncomingRefused: jest.fn((c: unknown) => c === refused) };
      await renderSheet(observer);
      await act(async () => undefined);

      expect(screen.queryByTestId('sw-hold-accept')).toBeNull();
      expect(screen.queryByTestId('sw-end-accept')).toBeNull();
      expect(screen.queryByTestId('sw-decline')).toBeNull();
    }
  );

  it('keeps the plain Answer with no call in progress', async () => {
    setCalls(call('b', 'inbound', 'ringing'));
    await renderSheet();
    expect(screen.getByTestId('sw-answer')).toBeTruthy();
    expect(screen.queryByTestId('sw-hold-accept')).toBeNull();
  });

  it('Hold & Accept answers through the observer with the live call held', async () => {
    const b = call('b', 'inbound', 'ringing');
    setCalls(call('a', 'outbound', 'connected'), b);
    const observer = { onIncomingAnswer: jest.fn(() => true) };
    const onAnswered = jest.fn();
    await renderSheet(observer, { onAnswered });
    await act(async () => undefined);

    await act(async () => fireEvent.press(screen.getByTestId('sw-hold-accept')));
    expect(observer.onIncomingAnswer).toHaveBeenCalledWith(b, 'hold');
    expect(onAnswered).toHaveBeenCalledWith(b);
  });

  it('End & Accept answers through the observer with the live call ended', async () => {
    const b = call('b', 'inbound', 'ringing');
    setCalls(call('a', 'outbound', 'connected'), b);
    const observer = { onIncomingAnswer: jest.fn(() => true) };
    await renderSheet(observer);
    await act(async () => undefined);

    await act(async () => fireEvent.press(screen.getByTestId('sw-end-accept')));
    expect(observer.onIncomingAnswer).toHaveBeenCalledWith(b, 'end');
  });

  it('Decline turns the waiting call down and leaves the live one alone', async () => {
    const a = call('a', 'outbound', 'connected');
    const b = call('b', 'inbound', 'ringing');
    setCalls(a, b);
    await renderSheet();
    await act(async () => undefined);

    await act(async () => fireEvent.press(screen.getByTestId('sw-decline')));
    expect(b.reject).toHaveBeenCalled();
    expect(a.hangup).not.toHaveBeenCalled();
  });

  it('answers a ringing push over a live call with the chosen handling', async () => {
    setCalls(call('a', 'outbound', 'connected'));
    mockRingingPushes.push({ uuid: 'push-1', fromName: 'Pushed' });
    await renderSheet(undefined, { includeNativePushes: true });
    await act(async () => undefined);

    await act(async () => fireEvent.press(screen.getByTestId('sw-end-accept')));
    expect(mockAnswerPush).toHaveBeenCalledWith('push-1', 'end');
  });
});
