import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { BehaviorSubject } from 'rxjs';

import { SignalWireContext } from '@signalwire/react';

import { IncomingCallSheet } from './IncomingCallSheet';

const incomingCalls$ = new BehaviorSubject<unknown[]>([]);

function renderSheet(props: Record<string, unknown> = {}): void {
  render(
    <SignalWireContext.Provider
      value={
        {
          client: { session: { incomingCalls$, incomingCalls: [] } },
          error: null,
          observer: undefined
        } as never
      }
    >
      <IncomingCallSheet {...props} />
    </SignalWireContext.Provider>
  );
}

beforeEach(() => incomingCalls$.next([]));

describe('IncomingCallSheet', () => {
  it('renders nothing when no call is pending', () => {
    renderSheet();
    expect(screen.queryByTestId('sw-answer')).toBeNull();
  });

  it('shows the caller name', () => {
    incomingCalls$.next([{ id: 'a', fromName: 'Ada Lovelace', answer: jest.fn(), reject: jest.fn() }]);
    renderSheet();
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
  });

  it('falls back to the handle, then to a placeholder', () => {
    incomingCalls$.next([{ id: 'a', from: '+15551234', answer: jest.fn(), reject: jest.fn() }]);
    renderSheet();
    expect(screen.getByText('+15551234')).toBeTruthy();
  });

  it('answers with audio and video by default', async () => {
    const call = { id: 'a', answer: jest.fn(async () => undefined), reject: jest.fn() };
    incomingCalls$.next([call]);
    renderSheet();

    fireEvent.press(screen.getByTestId('sw-answer'));
    await Promise.resolve();

    expect(call.answer).toHaveBeenCalledWith({ audio: true, video: true });
  });

  it('honours answerWith', async () => {
    const call = { id: 'a', answer: jest.fn(async () => undefined), reject: jest.fn() };
    incomingCalls$.next([call]);
    renderSheet({ answerWith: { audio: true, video: false } });

    fireEvent.press(screen.getByTestId('sw-answer'));
    await Promise.resolve();

    expect(call.answer).toHaveBeenCalledWith({ audio: true, video: false });
  });

  it('rejects on decline', async () => {
    const call = { id: 'a', answer: jest.fn(), reject: jest.fn(async () => undefined) };
    incomingCalls$.next([call]);
    renderSheet();

    fireEvent.press(screen.getByTestId('sw-decline'));
    await Promise.resolve();

    expect(call.reject).toHaveBeenCalled();
  });
});
