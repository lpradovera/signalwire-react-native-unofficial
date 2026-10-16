import { render, screen } from '@testing-library/react-native';
import React from 'react';
import { BehaviorSubject, Subject } from 'rxjs';

import { ParticipantList } from './ParticipantList';

function participant(id: string, name: string, { audioMuted = false, isTalking = false } = {}) {
  return {
    id,
    name,
    name$: new BehaviorSubject(name),
    audioMuted,
    audioMuted$: new BehaviorSubject(audioMuted),
    isTalking,
    isTalking$: new BehaviorSubject(isTalking)
  };
}

/** The SDK keeps the local member in participants$ and sets self$ from it. */
function createCall(others: ReturnType<typeof participant>[]) {
  const me = participant('me', 'Me');
  const participants = [me, ...others];
  return {
    id: 'call-1',
    status$: new BehaviorSubject('connected'),
    status: 'connected',
    participants$: new BehaviorSubject(participants),
    participants,
    self$: new BehaviorSubject(me),
    self: me,
    localStream$: new BehaviorSubject(null),
    localStream: null,
    remoteStream$: new BehaviorSubject(null),
    remoteStream: null,
    errors$: new Subject()
  };
}

describe('ParticipantList', () => {
  it('shows the empty state to a user alone in the room', async () => {
    await render(<ParticipantList call={createCall([]) as never} />);
    expect(screen.getByText('No one else is here yet.')).toBeTruthy();
    expect(screen.queryByTestId('sw-participant-me')).toBeNull();
  });

  it('lists the others, not the local user', async () => {
    await render(<ParticipantList call={createCall([participant('ada', 'Ada')]) as never} />);
    expect(screen.getByTestId('sw-participant-ada')).toBeTruthy();
    expect(screen.queryByTestId('sw-participant-me')).toBeNull();
  });

  it('makes each row one accessibility element that says who is talking', async () => {
    await render(
      <ParticipantList call={createCall([participant('ada', 'Ada', { isTalking: true })]) as never} />
    );
    const row = screen.getByTestId('sw-participant-ada');
    expect(row.props.accessible).toBe(true);
    expect(row.props.accessibilityLabel).toBe('Ada, talking');
  });
});
