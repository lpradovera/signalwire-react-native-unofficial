const listeners = new Map<string, (payload: unknown) => void>();

/** react-native-callkeep 4.3.16's event names (actions.js); any other name throws there. */
const KNOWN_EVENTS = new Set([
  'didReceiveStartCallAction',
  'answerCall',
  'endCall',
  'didActivateAudioSession',
  'didDeactivateAudioSession',
  'didDisplayIncomingCall',
  'didPerformSetMutedCallAction',
  'didToggleHoldCallAction',
  'didPerformDTMFAction',
  'didResetProvider',
  'checkReachability',
  'didLoadWithEvents',
  'showIncomingCallUi',
  'silenceIncomingCall',
  'createIncomingConnectionFailed',
  'didChangeAudioRoute',
  'onHasActiveCall'
]);

const RNCallKeep = {
  setup: jest.fn(async () => undefined),
  setAvailable: jest.fn(),
  displayIncomingCall: jest.fn(),
  answerIncomingCall: jest.fn(),
  rejectCall: jest.fn(),
  startCall: jest.fn(),
  reportConnectedOutgoingCallWithUUID: jest.fn(),
  setCurrentCallActive: jest.fn(),
  backToForeground: jest.fn(),
  reportEndCallWithUUID: jest.fn(),
  updateDisplay: jest.fn(),
  endCall: jest.fn(),
  addEventListener: jest.fn((event: string, handler: (payload: unknown) => void) => {
    if (!KNOWN_EVENTS.has(event)) {
      // What callkeep does: `listeners[type]` is undefined, and calling it throws.
      throw new TypeError(`listeners[type] is not a function (${event})`);
    }
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
