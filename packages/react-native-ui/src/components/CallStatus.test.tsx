import { act, render, screen } from '@testing-library/react-native';
import React from 'react';
import { BehaviorSubject, Subject } from 'rxjs';

import { CallStatus } from './CallStatus';

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
    errors$: new Subject<unknown>()
  };
}

describe('CallStatus', () => {
  it('keeps showing the status after a non-fatal error', async () => {
    // e.g. a keepalive pong that failed to send (VertoPongError, kind
    // 'internal'): the SDK reports it and the call carries on.
    const call = createCall();
    await render(<CallStatus call={call as never} testID="pill" />);

    await act(async () => {
      call.errors$.next({ kind: 'internal', fatal: false, error: new Error('pong'), callId: 'call-1' });
    });

    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.queryByText('internal error')).toBeNull();
  });

  it('shows a fatal error over the status', async () => {
    const call = createCall();
    await render(<CallStatus call={call as never} testID="pill" />);

    await act(async () => {
      call.errors$.next({ kind: 'media', fatal: true, error: new Error('ice'), callId: 'call-1' });
    });

    expect(screen.getByText('media error')).toBeTruthy();
  });

  it('is one accessibility element with its composed label', async () => {
    await render(<CallStatus call={createCall() as never} testID="pill" />);
    const pill = screen.getByTestId('pill');
    expect(pill.props.accessible).toBe(true);
    expect(pill.props.accessibilityLabel).toBe('Call status: Connected');
  });
});
