import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { BehaviorSubject } from 'rxjs';

import { SignalWireContext } from '@signalwire/react';

import { IncomingCallSheet } from './IncomingCallSheet';

const mockRingingPushes: Array<{ uuid: string; from?: string; fromName?: string }> = [];
const mockAnswerPush = jest.fn();
const mockRejectPush = jest.fn();
jest.mock('@signalwire/react-native/ringing', () => ({
  // The real name formatting; only the native ringing list is faked.
  displayableName: jest.requireActual('@signalwire/react-native/ringing').displayableName,
  useRingingPushes: () => ({ ringing: mockRingingPushes, answer: mockAnswerPush, reject: mockRejectPush })
}));

const incomingCalls$ = new BehaviorSubject<unknown[]>([]);

/** A call double that is still ringing, as the sheet requires. */
function ringingCall<T extends object>(fields: T): T & { status: 'ringing'; status$: BehaviorSubject<string> } {
  return { status: 'ringing', status$: new BehaviorSubject('ringing'), ...fields };
}

async function renderSheet(props: Record<string, unknown> = {}): Promise<void> {
  await render(
    <SignalWireContext.Provider
      value={
        {
          client: {
            isConnected$: new BehaviorSubject(true),
            session: { incomingCalls$, incomingCalls: [] }
          },
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
  it('renders nothing when no call is pending', async () => {
    await renderSheet();
    expect(screen.queryByTestId('sw-answer')).toBeNull();
  });

  it('shows the caller name', async () => {
    incomingCalls$.next([ringingCall({ id: 'a', fromName: 'Ada Lovelace', answer: jest.fn(), reject: jest.fn() })]);
    await renderSheet();
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
  });

  it('falls back to the handle, then to a placeholder', async () => {
    incomingCalls$.next([ringingCall({ id: 'a', from: '+15551234', answer: jest.fn(), reject: jest.fn() })]);
    await renderSheet();
    expect(screen.getByText('+15551234')).toBeTruthy();
  });

  it('shows "Unknown caller" when there is neither a name nor a handle', async () => {
    incomingCalls$.next([ringingCall({ id: 'a', answer: jest.fn(), reject: jest.fn() })]);
    await renderSheet();
    expect(screen.getByText('Unknown caller')).toBeTruthy();
  });

  it('never shows the backend\'s "_undef_" placeholder as a name', async () => {
    incomingCalls$.next([
      ringingCall({ id: 'a', fromName: '_undef_', from: '+15551234', answer: jest.fn(), reject: jest.fn() })
    ]);
    await renderSheet();
    expect(screen.queryByText('_undef_')).toBeNull();
    expect(screen.getByText('+15551234')).toBeTruthy();
  });

  it('falls back to "Unknown caller" when the name is a placeholder and there is no handle', async () => {
    incomingCalls$.next([ringingCall({ id: 'a', fromName: '  ', answer: jest.fn(), reject: jest.fn() })]);
    await renderSheet();
    expect(screen.getByText('Unknown caller')).toBeTruthy();
  });

  it('shows a Fabric address or SIP URI as a readable name', async () => {
    incomingCalls$.next([
      ringingCall({ id: 'a', fromName: '/private/rn-device-test', answer: jest.fn(), reject: jest.fn() })
    ]);
    await renderSheet();
    expect(screen.queryByText('/private/rn-device-test')).toBeNull();
    expect(screen.getByText('Rn Device Test')).toBeTruthy();
  });

  it('makes a native push\'s name readable too', async () => {
    mockRingingPushes.push({
      uuid: 'u9',
      fromName: '_undef_',
      from: 'sip:rn-example@0000.call.signalwire.com;context=private'
    });
    try {
      await renderSheet({ includeNativePushes: true });
      expect(screen.queryByText('_undef_')).toBeNull();
      expect(screen.getByText('Rn Example')).toBeTruthy();
    } finally {
      mockRingingPushes.length = 0;
    }
  });

  it('answers audio-only by default — an answer cannot add an m-line', async () => {
    const call = ringingCall({ id: 'a', answer: jest.fn(async () => undefined), reject: jest.fn() });
    incomingCalls$.next([call]);
    await renderSheet();

    fireEvent.press(screen.getByTestId('sw-answer'));
    await Promise.resolve();

    expect(call.answer).toHaveBeenCalledWith({ audio: true, video: false });
  });

  it('honours answerWith', async () => {
    const call = ringingCall({ id: 'a', answer: jest.fn(async () => undefined), reject: jest.fn() });
    incomingCalls$.next([call]);
    await renderSheet({ answerWith: { audio: true, video: false } });

    fireEvent.press(screen.getByTestId('sw-answer'));
    await Promise.resolve();

    expect(call.answer).toHaveBeenCalledWith({ audio: true, video: false });
  });

  it('rejects on decline', async () => {
    const call = ringingCall({ id: 'a', answer: jest.fn(), reject: jest.fn(async () => undefined) });
    incomingCalls$.next([call]);
    await renderSheet();

    fireEvent.press(screen.getByTestId('sw-decline'));
    await Promise.resolve();

    expect(call.reject).toHaveBeenCalled();
  });

  it('draws a call that is ringing natively with no SDK call yet', async () => {
    // Android registers callkeep self-managed and the OS draws nothing, so
    // without this a pushed call is invisible until it times out.
    mockRingingPushes.length = 0;
    mockRingingPushes.push({ uuid: 'u1', from: '+15551234567', fromName: 'Ada' });

    await renderSheet({ includeNativePushes: true });

    expect(screen.getByText('Ada')).toBeTruthy();
  });

  it('answers a native push through the registry, not the SDK', async () => {
    mockRingingPushes.length = 0;
    mockRingingPushes.push({ uuid: 'u2', fromName: 'Grace' });
    mockAnswerPush.mockClear();

    await renderSheet({ includeNativePushes: true });
    fireEvent.press(screen.getByTestId('sw-answer'));

    expect(mockAnswerPush).toHaveBeenCalledWith('u2', 'hold');
  });

  it('ignores native pushes when not asked for them', async () => {
    // iOS default: CallKit already drew the call, and a second sheet behind
    // its screen is confusing.
    mockRingingPushes.length = 0;
    mockRingingPushes.push({ uuid: 'u3', fromName: 'Ada' });

    await renderSheet({ includeNativePushes: false });

    expect(screen.queryByText('Ada')).toBeNull();
  });
  it('falls back to the number when the caller name is empty', async () => {
    // caller_id_name "" on the invite: '??' kept it, and the header was blank.
    incomingCalls$.next([ringingCall({ id: 'a', fromName: '', from: '+15551234', answer: jest.fn(), reject: jest.fn() })]);
    await renderSheet();
    expect(screen.getByText('+15551234')).toBeTruthy();
  });

  it('falls back to a placeholder when both name and number are empty', async () => {
    incomingCalls$.next([ringingCall({ id: 'a', fromName: '', from: '', answer: jest.fn(), reject: jest.fn() })]);
    await renderSheet();
    expect(screen.getByText('Unknown caller')).toBeTruthy();
  });

  it('falls back to the number for a pushed call with an empty name', async () => {
    // A push whose from_name is "" (the support server's POST /notify passes
    // fromName "" through).
    mockRingingPushes.length = 0;
    mockRingingPushes.push({ uuid: 'u1', fromName: '', from: '+15559876' });

    await renderSheet({ includeNativePushes: true });

    expect(screen.getByText('+15559876')).toBeTruthy();
  });
});
