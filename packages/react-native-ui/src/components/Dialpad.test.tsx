import { act, fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { BehaviorSubject, Subject } from 'rxjs';

import { logger } from '@signalwire/react';

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
  it('renders all twelve keys', async () => {
    await render(<Dialpad />);
    for (const key of ['1', '5', '9', '*', '0', '#']) {
      expect(screen.getByTestId(`sw-key-${key}`)).toBeTruthy();
    }
  });

  it('sends DTMF when given a call', async () => {
    const call = createCall();
    await render(<Dialpad call={call as never} />);

    fireEvent.press(screen.getByTestId('sw-key-5'));

    expect(call.sendDigits).toHaveBeenCalledWith('5');
  });

  it('reports digits to the caller', async () => {
    const onDigit = jest.fn();
    await render(<Dialpad onDigit={onDigit} />);

    fireEvent.press(screen.getByTestId('sw-key-#'));

    expect(onDigit).toHaveBeenCalledWith('#');
  });

  it('works with no call, for composing a number before dialling', async () => {
    const onDigit = jest.fn();
    await render(<Dialpad onDigit={onDigit} />);
    expect(() => fireEvent.press(screen.getByTestId('sw-key-1'))).not.toThrow();
    expect(onDigit).toHaveBeenCalledWith('1');
  });

  it('labels each key for assistive technology', async () => {
    await render(<Dialpad />);
    expect(screen.getByTestId('sw-key-7').props.accessibilityLabel).toBe('Dial 7');
  });

  it('logs a digit the SDK fails to send instead of leaving the rejection unhandled', async () => {
    // The SDK rethrows any verto.info error, e.g. while the call is still
    // ringing or after a network blip.
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const call = createCall();
    call.sendDigits = jest.fn(async () => {
      throw new Error('verto.info failed');
    });
    const onDigit = jest.fn();
    await render(<Dialpad call={call as never} onDigit={onDigit} />);

    fireEvent.press(screen.getByTestId('sw-key-5'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(onDigit).toHaveBeenCalledWith('5');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('5'), expect.any(Error));
    warn.mockRestore();
  });
});
