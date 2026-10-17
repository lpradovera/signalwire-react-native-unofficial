/**
 * useCall with calls shaped like @signalwire/js 4.0.0-rc.2's: every public
 * observable is `subject.asObservable().pipe(observeOn(asapScheduler))`, a new
 * object on each read whose replay lands in a microtask, and errors$ is a
 * ReplaySubject(1) that a healthy call never feeds. The plain-subject fakes
 * in useCall.test.tsx replay synchronously, which hid a snapshot that
 * outlived its call.
 */
import { act, render } from '@testing-library/react';
import React from 'react';
import { asapScheduler, BehaviorSubject, observeOn, ReplaySubject } from 'rxjs';

import { useCall } from './useCall';

import type { Observable } from 'rxjs';

const deferred = <T,>(subject: BehaviorSubject<T> | ReplaySubject<T>): Observable<T> =>
  subject.asObservable().pipe(observeOn(asapScheduler));

function sdkCall(id: string, status = 'connected') {
  const status$ = new BehaviorSubject(status);
  const errors$ = new ReplaySubject<{ kind: string; fatal: boolean; error: Error; callId: string }>(1);
  const audioMuted$ = new BehaviorSubject<boolean | undefined>(false);
  const self = {
    get audioMuted$() {
      return deferred(audioMuted$);
    },
    get audioMuted() {
      return audioMuted$.value;
    }
  };
  const self$ = new BehaviorSubject<unknown>(self);
  return {
    id,
    get status$() {
      return deferred(status$);
    },
    get status() {
      return status$.value;
    },
    get errors$() {
      return deferred(errors$);
    },
    get self$() {
      return deferred(self$);
    },
    get self() {
      return self$.value;
    },
    _status$: status$,
    _errors$: errors$,
    _audioMuted$: audioMuted$
  };
}

type SdkCall = ReturnType<typeof sdkCall>;

let result: ReturnType<typeof useCall> | undefined;
function Probe({ call }: { call: SdkCall | null }): React.JSX.Element {
  result = useCall(call as never);
  return <span data-testid="status">{result.status}</span>;
}

const flush = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe('useCall across a change of call (SDK observable shape)', () => {
  it("does not carry call A's error over to a healthy call B", async () => {
    const a = sdkCall('a');
    const b = sdkCall('b');
    const view = render(<Probe call={a} />);
    await flush();
    await act(async () => {
      a._errors$.next({ kind: 'media', fatal: false, error: new Error('media'), callId: 'a' });
    });
    await flush();
    expect(result?.error?.callId).toBe('a');

    view.rerender(<Probe call={b} />);
    await flush();

    expect(result?.error).toBeNull();
  });

  it("shows a fresh call's state for call={null}, not the last call's", async () => {
    const a = sdkCall('a', 'connected');
    const view = render(<Probe call={a} />);
    await flush();
    await act(async () => {
      a._audioMuted$.next(true);
    });
    await flush();
    expect(result?.status).toBe('connected');
    expect(result?.isAudioMuted).toBe(true);

    view.rerender(<Probe call={null} />);
    await flush();

    expect(result?.status).toBe('new');
    expect(result?.isAudioMuted).toBe(false);
    expect(result?.error).toBeNull();
  });

  it("shows call B's status from its getter before B's deferred replay lands", async () => {
    const a = sdkCall('a', 'connected');
    const b = sdkCall('b', 'ringing');
    const view = render(<Probe call={a} />);
    await flush();

    view.rerender(<Probe call={b} />);
    expect(result?.status).toBe('ringing');
    await flush();
    expect(result?.status).toBe('ringing');
  });
});
