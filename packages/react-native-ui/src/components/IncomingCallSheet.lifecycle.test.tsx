/**
 * The sheet against the SDK's inbound call lifecycle (@signalwire/js
 * 4.0.0-rc.2), which a plain array of call doubles does not show:
 *
 * - `session.incomingCalls$` filters `calls$` on `direction === 'inbound'`
 *   only (index.cjs:9201-9205), and a call leaves `calls$` only once it is
 *   'destroyed' (:9619-9622). An answered, connected or hanging-up inbound
 *   call stays in the list.
 * - `answer()` only pushes `answered$` (:8416-8419); the status moves to
 *   'connecting' and then 'connected' later, once the SDP answer is made.
 * - `reject()` keeps the call 'ringing' while the USER_BUSY bye is in flight,
 *   then it is 'disconnected' and destroyed (:6465-6489).
 * - `hangup()` makes it 'disconnecting' until the bye settles.
 * - `status` is a synchronous getter; `status$` replays through
 *   `observeOn(asapScheduler)` (deferEmission, :61-63).
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { asapScheduler, BehaviorSubject } from 'rxjs';
import { observeOn } from 'rxjs/operators';

import { SignalWireContext } from '@signalwire/react';

import { IncomingCallSheet } from './IncomingCallSheet';

jest.mock('@signalwire/react-native/ringing', () => ({
  // The real name formatting; only the native ringing list is faked.
  displayableName: jest.requireActual('@signalwire/react-native/ringing').displayableName,
  useRingingPushes: () => ({ ringing: [], answer: jest.fn(), reject: jest.fn() })
}));

type Status = 'ringing' | 'connecting' | 'connected' | 'disconnecting' | 'disconnected' | 'destroyed';

interface Gate {
  wait: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

const incomingCalls$ = new BehaviorSubject<FakeCall[]>([]);

class FakeCall {
  readonly direction = 'inbound';
  readonly answers: unknown[] = [];
  rejects = 0;
  /** Stands in for the verto.bye round trip. */
  readonly bye = gate();
  private readonly status$$: BehaviorSubject<Status>;

  constructor(
    readonly id: string,
    readonly fromName: string,
    initial: Status = 'ringing'
  ) {
    this.status$$ = new BehaviorSubject<Status>(initial);
  }

  get status(): Status {
    return this.status$$.value;
  }

  get status$() {
    return this.status$$.asObservable().pipe(observeOn(asapScheduler));
  }

  setStatus(status: Status): void {
    this.status$$.next(status);
    if (status === 'destroyed') {
      incomingCalls$.next(incomingCalls$.value.filter((call) => call !== this));
    }
  }

  answer(options?: unknown): void {
    this.answers.push(options);
    void Promise.resolve().then(async () => {
      this.setStatus('connecting');
      await Promise.resolve();
      this.setStatus('connected');
    });
  }

  reject(): void {
    this.rejects += 1;
    void this.bye.wait.then(() => {
      this.setStatus('disconnected');
      this.setStatus('destroyed');
    });
  }

  hangup(): void {
    this.setStatus('disconnecting');
    void this.bye.wait.then(() => {
      this.setStatus('disconnected');
      this.setStatus('destroyed');
    });
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

async function renderSheet(props: Record<string, unknown> = {}): Promise<void> {
  await render(
    <SignalWireContext.Provider
      value={
        {
          client: {
            isConnected$: new BehaviorSubject(true),
            session: { incomingCalls$, incomingCalls: incomingCalls$.value }
          },
          error: null,
          observer: undefined
        } as never
      }
    >
      <IncomingCallSheet {...props} />
    </SignalWireContext.Provider>
  );
  await flush();
}

beforeEach(() => incomingCalls$.next([]));

describe('IncomingCallSheet over the SDK call lifecycle', () => {
  it('goes away when the user answers, and stays away while the call is connected', async () => {
    const call = new FakeCall('in-1', 'Ada');
    incomingCalls$.next([call]);
    const onAnswered = jest.fn();
    await renderSheet({ onAnswered });
    expect(screen.getByText('Ada')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('sw-answer'));
    // Before the SDK has moved the status on.
    expect(screen.queryByTestId('sw-answer')).toBeNull();

    await flush();
    expect(call.status).toBe('connected');
    expect(incomingCalls$.value).toContain(call);
    expect(screen.queryByTestId('sw-answer')).toBeNull();
    expect(screen.queryByText('Incoming call')).toBeNull();
    expect(call.answers).toHaveLength(1);
    expect(onAnswered).toHaveBeenCalledTimes(1);
  });

  it('goes away on Decline while the bye is still in flight', async () => {
    const call = new FakeCall('in-1', 'Ada');
    incomingCalls$.next([call]);
    const onRejected = jest.fn();
    const onAnswered = jest.fn();
    await renderSheet({ onAnswered, onRejected });

    await fireEvent.press(screen.getByTestId('sw-decline'));
    await flush();

    // The SDK still reports the declined call as ringing.
    expect(call.status).toBe('ringing');
    expect(call.rejects).toBe(1);
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('sw-answer')).toBeNull();

    call.bye.open();
    await flush();
    expect(screen.queryByTestId('sw-answer')).toBeNull();
    expect(onAnswered).not.toHaveBeenCalled();
  });

  it('does not offer a call that was answered elsewhere (native call UI)', async () => {
    const call = new FakeCall('in-1', 'Ada');
    incomingCalls$.next([call]);
    await renderSheet();
    expect(screen.getByText('Ada')).toBeTruthy();

    // CallKit's answer action calls call.answer itself.
    await act(async () => {
      call.answer();
    });
    await flush();

    expect(screen.queryByTestId('sw-answer')).toBeNull();
  });

  it('does not slide up for an answered call that is hanging up', async () => {
    const call = new FakeCall('in-1', 'Ada', 'connected');
    incomingCalls$.next([call]);
    await renderSheet();
    expect(screen.queryByTestId('sw-answer')).toBeNull();

    await act(async () => {
      call.hangup();
    });
    await flush();
    expect(call.status).toBe('disconnecting');
    expect(screen.queryByTestId('sw-answer')).toBeNull();
  });

  it('shows a second, waiting call over one in progress', async () => {
    const active = new FakeCall('in-1', 'Ada', 'connected');
    const waiting = new FakeCall('in-2', 'Grace');
    incomingCalls$.next([active, waiting]);
    await renderSheet();

    expect(screen.queryByText('Ada')).toBeNull();
    expect(screen.getByText('Grace')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('sw-answer'));
    expect(waiting.answers).toHaveLength(1);
    expect(active.answers).toHaveLength(0);
  });

  it('comes back when the answer fails and the call is still ringing', async () => {
    const call = new FakeCall('in-1', 'Ada');
    call.answer = () => {
      throw new Error('no media');
    };
    incomingCalls$.next([call]);
    const onAnswered = jest.fn();
    await renderSheet({ onAnswered });

    await fireEvent.press(screen.getByTestId('sw-answer'));
    await flush();

    expect(onAnswered).not.toHaveBeenCalled();
    expect(screen.getByTestId('sw-answer')).toBeTruthy();
  });
});
