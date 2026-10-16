const listeners = new Map<string, (payload: unknown) => void>();

const RNCallKeep = {
  setup: jest.fn(async () => undefined),
  setAvailable: jest.fn(),
  displayIncomingCall: jest.fn(),
  answerIncomingCall: jest.fn(),
  rejectCall: jest.fn(),
  startCall: jest.fn(),
  reportConnectedOutgoingCallWithUUID: jest.fn(),
  reportEndCallWithUUID: jest.fn(),
  endCall: jest.fn(),
  addEventListener: jest.fn((event: string, handler: (payload: unknown) => void) => {
    listeners.set(event, handler);
  }),
  removeEventListener: jest.fn((event: string) => {
    listeners.delete(event);
  }),
  /** Test helper — fire a native event. */
  __emit: (event: string, payload: unknown) => listeners.get(event)?.(payload),
  __reset: () => listeners.clear()
};

/**
 * callkeep 4.3.16's table (index.js), which differs per platform. Read at
 * access time from the test's mocked Platform; callkeep reads it at import.
 */
export const CONSTANTS = {
  get END_CALL_REASONS() {
    const { Platform } = require('react-native') as { Platform?: { OS?: string } };
    const isIOS = Platform?.OS === 'ios';
    return {
      FAILED: 1,
      REMOTE_ENDED: 2,
      UNANSWERED: 3,
      ANSWERED_ELSEWHERE: 4,
      DECLINED_ELSEWHERE: isIOS ? 5 : 2,
      MISSED: isIOS ? 2 : 6
    };
  }
};

export default RNCallKeep;
