jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('@react-native-firebase/messaging', () => ({}), { virtual: true });

import { decodePushData } from './androidCallPush';

describe('decodePushData', () => {
  it('restores keys the sender had to rename for FCM', () => {
    // FCM rejects `from` in a data payload, failing the whole message, so the
    // server sends `sw_from`. Both platforms must hand the registry the same
    // shape or the caller id silently goes missing on one of them.
    const decoded = decodePushData({
      call_id: 'c1',
      sw_from: '+15551234567',
      from_name: 'Ada',
      bridgeToken: 'tok-1'
    });

    expect(decoded.from).toBe('+15551234567');
    expect(decoded.sw_from).toBeUndefined();
    expect(decoded.call_id).toBe('c1');
    expect(decoded.from_name).toBe('Ada');
  });

  it('carries the bridge token through untouched', () => {
    // Without it the answer has nothing to dial and the caller stays parked.
    expect(decodePushData({ bridgeToken: 'tok-2' }).bridgeToken).toBe('tok-2');
  });

  it('leaves an already-plain payload alone', () => {
    expect(decodePushData({ from: 'x' })).toEqual({ from: 'x' });
  });
});
