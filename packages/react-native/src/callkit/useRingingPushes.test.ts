jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));

import { ringingFrom } from './useRingingPushes';

import type { CallEntry } from './types';

function entry(over: Partial<CallEntry>): CallEntry {
  return {
    uuid: 'u1',
    state: 'pending-push',
    expectedCallId: null,
    call: null,
    handle: '+15551234567',
    displayName: 'Ada',
    intent: null,
    fuseDeadline: null,
    ...over
  } as CallEntry;
}

describe('ringingFrom', () => {
  it('surfaces a push that is ringing with no SDK call yet', () => {
    // Android registers callkeep self-managed, so Telecom draws no incoming
    // call UI at all. Without this the push arrives, a connection exists, and
    // the user sees nothing.
    const ringing = ringingFrom([entry({ data: { bridgeToken: 'tok' } })]);

    expect(ringing).toHaveLength(1);
    const [first] = ringing;
    expect(first).toMatchObject({
      uuid: 'u1',
      from: '+15551234567',
      fromName: 'Ada'
    });
    // Without the token the answer has nothing to dial.
    expect(first?.data?.bridgeToken).toBe('tok');
  });

  it('drops an entry once an intent is applied, so the sheet does not linger', () => {
    expect(ringingFrom([entry({ intent: 'answer' })])).toHaveLength(0);
  });

  it('ignores entries that already have an SDK call', () => {
    expect(ringingFrom([entry({ state: 'fused', call: {} as never })])).toHaveLength(0);
  });

  it('returns one stable reference when empty', () => {
    // useSyncExternalStore compares snapshots with Object.is and calls
    // getSnapshot on every render. A fresh [] each time is a new snapshot each
    // time — an infinite render loop reported as "Maximum update depth
    // exceeded", with nothing pointing at the `.map()` that caused it.
    expect(ringingFrom([])).toBe(ringingFrom([entry({ intent: 'reject' })]));
  });
});
