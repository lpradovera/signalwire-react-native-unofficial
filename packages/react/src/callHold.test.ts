import { CallHoldState } from './callHold';

import type { Call } from '@signalwire/js';

jest.mock('@signalwire/js', () => ({
  getLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() })
}));

/** @signalwire/js rc.5's shape: toggleHold() flips a private flag once its RPC resolves. */
function sdkCall(id = 'a') {
  const call = {
    id,
    _holdState: false,
    sent: [] as string[],
    toggleHold: jest.fn(async () => {
      call.sent.push(call._holdState ? 'unhold' : 'hold');
      await Promise.resolve();
      call._holdState = !call._holdState;
    })
  };
  return call;
}

describe('CallHoldState', () => {
  it('sends hold only when the call is not held, and publishes it', async () => {
    const state = new CallHoldState();
    const call = sdkCall();
    const seen: boolean[] = [];
    state.held$.subscribe((held) => seen.push(held.has(call as unknown as Call)));

    await state.setHeld(call as unknown as Call, true);
    await state.setHeld(call as unknown as Call, true);

    expect(call.sent).toEqual(['hold']);
    expect(state.isHeld(call as unknown as Call)).toBe(true);
    expect(seen).toEqual([false, true]);
  });

  it('applies a hold and a resume sent back to back in order, not as two toggles of one state', async () => {
    const state = new CallHoldState();
    const call = sdkCall();
    const hold = state.setHeld(call as unknown as Call, true);
    const resume = state.setHeld(call as unknown as Call, false);
    await Promise.all([hold, resume]);
    expect(call.sent).toEqual(['hold', 'unhold']);
    expect(state.isHeld(call as unknown as Call)).toBe(false);
  });

  it('reads a hold made with toggleHold() directly from the SDK flag', async () => {
    const state = new CallHoldState();
    const call = sdkCall();
    await call.toggleHold();
    await state.setHeld(call as unknown as Call, true);
    expect(call.sent).toEqual(['hold']);
  });

  it('keeps the state when the request fails, and the next request still runs', async () => {
    const state = new CallHoldState();
    const call = sdkCall();
    call.toggleHold.mockRejectedValueOnce(new Error('rpc timeout'));

    await expect(state.setHeld(call as unknown as Call, true)).rejects.toThrow('rpc timeout');
    expect(state.isHeld(call as unknown as Call)).toBe(false);

    await state.setHeld(call as unknown as Call, true);
    expect(state.isHeld(call as unknown as Call)).toBe(true);
  });

  it('tracks a call without the SDK flag by what it applied', async () => {
    const state = new CallHoldState();
    const call = { id: 'x', toggleHold: jest.fn(async () => undefined) } as unknown as Call;
    await state.setHeld(call, true);
    await state.setHeld(call, true);
    expect(call.toggleHold).toHaveBeenCalledTimes(1);
    expect(state.isHeld(call)).toBe(true);
  });

  it('forgets an ended call', async () => {
    const state = new CallHoldState();
    const call = sdkCall();
    await state.setHeld(call as unknown as Call, true);
    state.forget(call as unknown as Call);
    expect(state.held.size).toBe(0);
  });
});
