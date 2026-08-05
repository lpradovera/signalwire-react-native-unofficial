import { act, render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';
import { BehaviorSubject, Subject } from 'rxjs';

import { useObservable } from './useObservable';

function Probe({
  source,
  initial
}: {
  source?: Subject<string> | BehaviorSubject<string>;
  initial: string;
}): React.JSX.Element {
  const value = useObservable(source, initial);
  return <Text testID="value">{value}</Text>;
}

describe('useObservable', () => {
  it('seeds from a BehaviorSubject current value without flashing the initial', () => {
    const subject = new BehaviorSubject('ready');
    const { getByTestId } = render(<Probe source={subject} initial="placeholder" />);
    expect(getByTestId('value').props.children).toBe('ready');
  });

  it('falls back to the initial value for a Subject with no current value', () => {
    const subject = new Subject<string>();
    const { getByTestId } = render(<Probe source={subject} initial="placeholder" />);
    expect(getByTestId('value').props.children).toBe('placeholder');
  });

  it('re-renders on emission', () => {
    const subject = new BehaviorSubject('first');
    const { getByTestId } = render(<Probe source={subject} initial="placeholder" />);
    act(() => subject.next('second'));
    expect(getByTestId('value').props.children).toBe('second');
  });

  it('returns the initial value when the observable is undefined', () => {
    const { getByTestId } = render(<Probe source={undefined} initial="placeholder" />);
    expect(getByTestId('value').props.children).toBe('placeholder');
  });

  it('resubscribes when the observable identity changes', () => {
    const first = new BehaviorSubject('one');
    const second = new BehaviorSubject('two');
    const { getByTestId, rerender } = render(<Probe source={first} initial="placeholder" />);
    expect(getByTestId('value').props.children).toBe('one');

    rerender(<Probe source={second} initial="placeholder" />);
    expect(getByTestId('value').props.children).toBe('two');
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
      return <Text>{String(value.id)}</Text>;
    }

    const { rerender } = render(<ObjectProbe />);
    rerender(<ObjectProbe />);

    expect(snapshots.length).toBeGreaterThan(1);
    expect(snapshots[0]).toBe(snapshots[snapshots.length - 1]);
  });
});
