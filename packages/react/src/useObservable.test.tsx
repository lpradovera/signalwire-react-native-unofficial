import { act, render } from '@testing-library/react';
import React from 'react';
import { asapScheduler, BehaviorSubject, observeOn, Subject } from 'rxjs';

import { useObservable } from './useObservable';

function Probe({
  source,
  initial
}: {
  source?: Subject<string> | BehaviorSubject<string>;
  initial: string;
}): React.JSX.Element {
  const value = useObservable(source, initial);
  return <span data-testid="value">{value}</span>;
}

describe('useObservable', () => {
  it('seeds from a BehaviorSubject current value without flashing the initial', () => {
    const subject = new BehaviorSubject('ready');
    const { getByTestId } = render(<Probe source={subject} initial="placeholder" />);
    expect(getByTestId('value').textContent).toBe('ready');
  });

  it('falls back to the initial value for a Subject with no current value', () => {
    const subject = new Subject<string>();
    const { getByTestId } = render(<Probe source={subject} initial="placeholder" />);
    expect(getByTestId('value').textContent).toBe('placeholder');
  });

  it('re-renders on emission', () => {
    const subject = new BehaviorSubject('first');
    const { getByTestId } = render(<Probe source={subject} initial="placeholder" />);
    act(() => subject.next('second'));
    expect(getByTestId('value').textContent).toBe('second');
  });

  it('returns the initial value when the observable is undefined', () => {
    const { getByTestId } = render(<Probe source={undefined} initial="placeholder" />);
    expect(getByTestId('value').textContent).toBe('placeholder');
  });

  it('resubscribes when the observable identity changes', () => {
    const first = new BehaviorSubject('one');
    const second = new BehaviorSubject('two');
    const { getByTestId, rerender } = render(<Probe source={first} initial="placeholder" />);
    expect(getByTestId('value').textContent).toBe('one');

    rerender(<Probe source={second} initial="placeholder" />);
    expect(getByTestId('value').textContent).toBe('two');
  });

  it('unsubscribes on unmount', () => {
    const subject = new BehaviorSubject('value');
    const { unmount } = render(<Probe source={subject} initial="placeholder" />);
    expect(subject.observed).toBe(true);
    unmount();
    expect(subject.observed).toBe(false);
  });

  it('unsubscribes from the previous observable when it is swapped', () => {
    const first = new BehaviorSubject('one');
    const second = new BehaviorSubject('two');
    const { rerender } = render(<Probe source={first} initial="placeholder" />);
    rerender(<Probe source={second} initial="placeholder" />);
    expect(first.observed).toBe(false);
    expect(second.observed).toBe(true);
  });

  it('returns a stable snapshot reference between emissions', () => {
    const subject = new BehaviorSubject({ id: 1 });
    const snapshots: unknown[] = [];

    function ObjectProbe(): React.JSX.Element {
      const value = useObservable<{ id: number }>(subject, { id: 0 });
      snapshots.push(value);
      return <span>{String(value.id)}</span>;
    }

    const { rerender } = render(<ObjectProbe />);
    rerender(<ObjectProbe />);

    expect(snapshots.length).toBeGreaterThan(1);
    expect(snapshots[0]).toBe(snapshots[snapshots.length - 1]);
  });

  /**
   * The SDK does not hand out plain BehaviorSubjects. Its getters return
   * `deferEmission(subject.asObservable())`, i.e. `observeOn(asapScheduler)` —
   * a *new object every access* whose replay lands in a microtask. Reproduced
   * here because the friendly mocks above hid a bug that left `isConnected`
   * false for the whole life of a connected client.
   */
  describe('against the SDK observable shape', () => {
    /** Mimics `get isConnected$()`: fresh identity, deferred emission. */
    function sdkGetter<T>(subject: BehaviorSubject<T>) {
      return () => subject.asObservable().pipe(observeOn(asapScheduler));
    }

    function SdkProbe({ getter, current }: { getter: () => any; current: () => string }) {
      const value = useObservable<string>(getter(), current());
      return <span data-testid="value">{value}</span>;
    }

    it('uses the synchronous getter until the deferred emission arrives', () => {
      const subject = new BehaviorSubject('connected');
      const { getByTestId } = render(
        <SdkProbe getter={sdkGetter(subject)} current={() => subject.value} />
      );

      // Nothing has emitted yet — asapScheduler defers it — so the value must
      // come from the caller's synchronous getter, not the stale first render.
      expect(getByTestId('value').textContent).toBe('connected');
    });

    it('keeps a deferred emission through the re-render it triggers', async () => {
      const subject = new BehaviorSubject('connecting');
      const { getByTestId } = render(
        <SdkProbe getter={sdkGetter(subject)} current={() => subject.value} />
      );

      await act(async () => {
        subject.next('connected');
        await Promise.resolve();
      });

      // Regression: the store was rebuilt on every render because the getter
      // returns a new object, resetting the snapshot to the first-render value.
      expect(getByTestId('value').textContent).toBe('connected');
    });


    it('does not loop when a fresh-identity getter emits fresh objects', () => {
      // The freeze: `addresses$` builds a new array per emission and the getter
      // builds a new observable per access. Keyed on the observable, React
      // re-subscribed every render, each re-subscription delivered an array
      // that failed Object.is, which rendered, which re-subscribed — locking
      // the JS thread hard enough for Chrome to offer to kill the page.
      const subject = new BehaviorSubject<string[]>(['a']);
      let renders = 0;

      function ArrayProbe() {
        renders++;
        const items = useObservable<string[]>(
          // A new pipe AND a new array mapping on every single access.
          subject.asObservable().pipe(observeOn(asapScheduler)),
          subject.value
        );
        return <span data-testid="value">{items.join(',')}</span>;
      }

      const { getByTestId, rerender } = render(<ArrayProbe />);
      for (let i = 0; i < 5; i++) {
        rerender(<ArrayProbe />);
      }

      // Without the fix this never settles. Bounded renders is the assertion.
      expect(renders).toBeLessThan(20);
      expect(getByTestId('value').textContent).toBe('a');
    });

    it('does not strand the initial value when identity changes every render', async () => {
      const subject = new BehaviorSubject(false);

      function Flip() {
        const connected = useObservable<boolean>(
          subject.asObservable().pipe(observeOn(asapScheduler)),
          subject.value
        );
        return <span data-testid="value">{String(connected)}</span>;
      }

      const { getByTestId, rerender } = render(<Flip />);
      expect(getByTestId('value').textContent).toBe('false');

      await act(async () => {
        subject.next(true);
        await Promise.resolve();
      });
      rerender(<Flip />);

      expect(getByTestId('value').textContent).toBe('true');
    });
  });
});
