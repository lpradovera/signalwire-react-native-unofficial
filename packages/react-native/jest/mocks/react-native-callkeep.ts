const listeners = new Map<string, (payload: unknown) => void>();

const RNCallKeep = {
  setup: jest.fn(async () => undefined),
  setAvailable: jest.fn(),
  displayIncomingCall: jest.fn(),
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

export const CONSTANTS = {
  END_CALL_REASONS: {
    FAILED: 1,
    REMOTE_ENDED: 2,
    UNANSWERED: 3,
    ANSWERED_ELSEWHERE: 4,
    DECLINED_ELSEWHERE: 5,
    MISSED: 6
  }
};

export default RNCallKeep;
