type Handler = (payload: unknown) => void;

/** Every handler per event, as callkeep keeps them (one Set per event type). */
const listeners = new Map<string, Set<Handler>>();

/**
 * callkeep 4.3.0-4.3.8: addEventListener returns nothing and keeps one
 * subscription per type in `_callkeepEventHandlers` (a later handler of the
 * same type overwrites the slot, its predecessor stays subscribed);
 * removeEventListener(type) removes the subscription in that slot.
 */
let legacyApi = false;
const legacyHandlers = new Map<string, { remove(): void }>();

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
  clearInitialEvents: jest.fn(),
  endCall: jest.fn(),
  setOnHold: jest.fn(),
  /** Like callkeep 4.3.16: returns an EventListener whose remove() drops this handler only. */
  addEventListener: jest.fn((event: string, handler: Handler) => {
    if (!KNOWN_EVENTS.has(event)) {
      // What callkeep does: `listeners[type]` is undefined, and calling it throws.
      throw new TypeError(`listeners[type] is not a function (${event})`);
    }
    const set = listeners.get(event) ?? new Set<Handler>();
    set.add(handler);
    listeners.set(event, set);
    const subscription = { remove: jest.fn(() => void listeners.get(event)?.delete(handler)) };
    if (legacyApi) {
      legacyHandlers.set(event, subscription);
      return undefined;
    }
    return subscription;
  }),
  /** Like callkeep 4.3.16: without a listener, removes every handler of the type. */
  removeEventListener: jest.fn((event: string, handler?: Handler) => {
    if (legacyApi) {
      legacyHandlers.get(event)?.remove();
      legacyHandlers.delete(event);
    } else if (handler) {
      listeners.get(event)?.delete(handler);
    } else {
      listeners.delete(event);
    }
  }),
  /** Test helper — fire a native event. */
  __emit: (event: string, payload: unknown) => {
    for (const handler of [...(listeners.get(event) ?? [])]) {
      handler(payload);
    }
  },
  /** Test helper — behave like callkeep 4.3.0-4.3.8 (see {@link legacyApi}). */
  __useLegacyApi: (): void => {
    legacyApi = true;
  },
  __reset: () => {
    listeners.clear();
    legacyHandlers.clear();
    legacyApi = false;
  }
};

/** callkeep 4.3.0-4.3.8's per-type subscription slot, on the instance as there. */
Object.defineProperty(RNCallKeep, '_callkeepEventHandlers', {
  get: () => legacyHandlers,
  enumerable: false
});

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
