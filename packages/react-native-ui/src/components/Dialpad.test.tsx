import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { BehaviorSubject, Subject } from 'rxjs';

import { Dialpad } from './Dialpad';

function createCall() {
  return {
    id: 'call-1',
    status$: new BehaviorSubject('connected'),
    status: 'connected',
    participants$: new BehaviorSubject([]),
    participants: [],
    self$: new BehaviorSubject(null),
    self: null,
    localStream$: new BehaviorSubject(null),
    localStream: null,
    remoteStream$: new BehaviorSubject(null),
    remoteStream: null,
    errors$: new Subject(),
    hangup: jest.fn(async () => undefined),
    toggleHold: jest.fn(async () => undefined),
    sendDigits: jest.fn(async () => undefined)
  };
}

describe('Dialpad', () => {
  it('renders all twelve keys', () => {
    render(<Dialpad />);
    for (const key of ['1', '5', '9', '*', '0', '#']) {
      expect(screen.getByTestId(`sw-key-${key}`)).toBeTruthy();
    }
  });

  it('sends DTMF when given a call', () => {
    const call = createCall();
    render(<Dialpad call={call as never} />);

    fireEvent.press(screen.getByTestId('sw-key-5'));

    expect(call.sendDigits).toHaveBeenCalledWith('5');
  });

  it('reports digits to the caller', () => {
    const onDigit = jest.fn();
    render(<Dialpad onDigit={onDigit} />);

    fireEvent.press(screen.getByTestId('sw-key-#'));

    expect(onDigit).toHaveBeenCalledWith('#');
  });

  it('works with no call, for composing a number before dialling', () => {
    const onDigit = jest.fn();
    render(<Dialpad onDigit={onDigit} />);
    expect(() => fireEvent.press(screen.getByTestId('sw-key-1'))).not.toThrow();
    expect(onDigit).toHaveBeenCalledWith('1');
  });

  it('labels each key for assistive technology', () => {
    render(<Dialpad />);
    expect(screen.getByTestId('sw-key-7').props.accessibilityLabel).toBe('Dial 7');
  });
});
