/**
 * The bridge on Android: a self-managed ConnectionService through callkeep.
 *
 * Telecom draws nothing for a self-managed call, keeps a connection RINGING or
 * DIALING until the app sets it active, and callkeep requests no permission at
 * all in self-managed mode. Each of those is the app's job, so the package's.
 */
import RNCallKeep from 'react-native-callkeep';
import { BehaviorSubject, Subject } from 'rxjs';

import { CallKeepBridge } from './CallKeepBridge';

const mockAppState = {
  currentState: 'active' as string,
  listeners: [] as Array<(state: string) => void>
};
const mockPermissions = {
  requests: [] as string[][],
  result: 'granted' as string
};
const mockIncomingCall = {
  show: jest.fn(async () => true),
  cancel: jest.fn(),
  release: jest.fn()
};
let mockApiLevel = 35;
let mockNativeModuleLinked = true;

jest.mock('react-native', () => ({
  get Platform() {
    return { OS: 'android', Version: mockApiLevel };
  },
  AppState: {
    get currentState() {
      return mockAppState.currentState;
    },
    addEventListener: (_type: string, listener: (state: string) => void) => {
      mockAppState.listeners.push(listener);
      return {
        remove: () => {
          mockAppState.listeners = mockAppState.listeners.filter((l) => l !== listener);
        }
      };
    }
  },
  PermissionsAndroid: {
    requestMultiple: async (permissions: string[]) => {
      mockPermissions.requests.push(permissions);
      return Object.fromEntries(permissions.map((p) => [p, mockPermissions.result]));
    }
  },
  get NativeModules() {
    // callkeep is linked throughout (setup() checks for RNCallKeep); the
    // package's own Android module only when the test says so.
    return mockNativeModuleLinked
      ? { RNCallKeep: { setup: () => undefined }, SignalWireIncomingCall: mockIncomingCall }
      : { RNCallKeep: { setup: () => undefined } };
  }
}));

const callkeep = RNCallKeep as unknown as typeof RNCallKeep & {
  __emit: (event: string, payload: unknown) => void;
  __reset: () => void;
};

function createCall(id: string) {
  const status$ = new BehaviorSubject('ringing');
  return {
    id,
    from: '+15551234',
    fromName: 'Ada',
    status$,
    answer: jest.fn(),
    reject: jest.fn(),
    hangup: jest.fn(async () => undefined),
    self: { mute: jest.fn(), unmute: jest.fn() }
  };
}

function setActive(state: string) {
  mockAppState.currentState = state;
  for (const listener of [...mockAppState.listeners]) {
    listener(state);
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('CallKeepBridge on Android', () => {
  let bridge: CallKeepBridge;

  beforeEach(() => {
    jest.clearAllMocks();
    callkeep.__reset();
    mockAppState.currentState = 'active';
    mockAppState.listeners = [];
    mockPermissions.requests = [];
    mockPermissions.result = 'granted';
    mockApiLevel = 35;
    mockNativeModuleLinked = true;
    bridge = new CallKeepBridge();
  });

  afterEach(() => bridge.destroy());

  describe('connected calls are set active in Telecom', () => {
    it('sets an outgoing call active when it connects', async () => {
      await bridge.setup({ appName: 'Demo' });
      const call = createCall('out-1');
      const uuid = bridge.trackCall(call as never, '+15550001', 'Bob');

      call.status$.next('connected');

      expect(RNCallKeep.setCurrentCallActive).toHaveBeenCalledWith(uuid);
    });

    it('sets an answered incoming call active when it connects', async () => {
      await bridge.setup({ appName: 'Demo' });
      const uuid = bridge.reportIncomingPush({ callId: 'in-1', from: '+1555', fromName: 'Ada' });
      const call = createCall('in-1');
      const incoming$ = new Subject<unknown[]>();
      bridge.bindClient({ session: { incomingCalls$: incoming$ } } as never);
      incoming$.next([call]);
      callkeep.__emit('answerCall', { callUUID: uuid });

      call.status$.next('connected');

      expect(RNCallKeep.setCurrentCallActive).toHaveBeenCalledWith(uuid);
    });
  });

  describe('runtime permissions', () => {
    it('asks for what the ConnectionService and the call need', async () => {
      await bridge.setup({ appName: 'Demo' });
      await flush();

      expect(mockPermissions.requests).toHaveLength(1);
      expect(mockPermissions.requests[0]).toEqual(
        expect.arrayContaining([
          // TelecomManager.getPhoneAccount in callkeep's createConnection:
          // ungranted, the app dies on the first incoming or outgoing call.
          'android.permission.READ_PHONE_NUMBERS',
          // callkeep's startCall is ignored without it in self-managed mode.
          'android.permission.RECORD_AUDIO',
          'android.permission.POST_NOTIFICATIONS',
          'android.permission.BLUETOOTH_CONNECT'
        ])
      );
      expect(mockPermissions.requests[0]).not.toContain('android.permission.CAMERA');
    });

    // An audio-only app with the native video button on still has no use for
    // the camera until a call sends video, and react-native-webrtc's
    // getUserMedia asks for it then.
    it('does not ask for the camera up front, even when the app offers video', async () => {
      await bridge.setup({ appName: 'Demo', supportsVideo: true });
      await flush();
      expect(mockPermissions.requests[0]).not.toContain('android.permission.CAMERA');
    });

    it('asks only for what exists at the API level', async () => {
      mockApiLevel = 30;
      await bridge.setup({ appName: 'Demo' });
      await flush();
      expect(mockPermissions.requests[0]).not.toContain('android.permission.POST_NOTIFICATIONS');
      expect(mockPermissions.requests[0]).not.toContain('android.permission.BLUETOOTH_CONNECT');
    });

    it('waits for the app to come forward when set up from a headless task', async () => {
      // A push for a killed app runs setup() with no activity to ask from.
      mockAppState.currentState = 'background';
      await bridge.setup({ appName: 'Demo' });
      await flush();
      expect(mockPermissions.requests).toHaveLength(0);

      setActive('active');
      await flush();
      expect(mockPermissions.requests).toHaveLength(1);

      setActive('background');
      setActive('active');
      await flush();
      expect(mockPermissions.requests).toHaveLength(1);
    });
  });

  it('gives the ongoing-call notification a small icon', async () => {
    // callkeep builds the foreground-service notification with no icon unless
    // told one, and Android refuses a notification without one.
    await bridge.setup({ appName: 'Demo' });
    const options = (RNCallKeep.setup as jest.Mock).mock.calls[0][0] as {
      android: { foregroundService: { notificationIcon?: string } };
    };
    expect(options.android.foregroundService.notificationIcon).toBe('ic_launcher');
  });

  describe('the incoming-call notification', () => {
    async function ringingPush() {
      await bridge.setup({ appName: 'Demo' });
      const uuid = bridge.reportIncomingPush({ callId: 'c1', from: '+15551234', fromName: 'Ada' });
      return uuid;
    }

    it('is posted when Telecom asks for incoming-call UI while the app is in the background', async () => {
      mockAppState.currentState = 'background';
      const uuid = await ringingPush();

      callkeep.__emit('showIncomingCallUi', { callUUID: uuid, handle: '+15551234', name: 'Ada' });

      expect(mockIncomingCall.show).toHaveBeenCalledWith(
        uuid,
        '+15551234',
        'Ada',
        false,
        'Incoming calls'
      );
    });

    it('is not posted over the app itself, which shows its own ringing UI', async () => {
      const uuid = await ringingPush();
      callkeep.__emit('showIncomingCallUi', { callUUID: uuid, handle: '+15551234', name: 'Ada' });
      expect(mockIncomingCall.show).not.toHaveBeenCalled();
    });

    it.each([
      ['answered', (uuid: string) => callkeep.__emit('answerCall', { callUUID: uuid })],
      ['declined', (uuid: string) => callkeep.__emit('endCall', { callUUID: uuid })],
      ['ended by the app', (uuid: string) => bridge.registry.endCall(uuid)]
    ])('is withdrawn once the call is %s', async (_label, act) => {
      mockAppState.currentState = 'background';
      const uuid = await ringingPush();
      callkeep.__emit('showIncomingCallUi', { callUUID: uuid, handle: '+15551234', name: 'Ada' });

      act(uuid);

      expect(mockIncomingCall.cancel).toHaveBeenCalledWith(uuid);
    });

    it('keeps an answered call over the lock screen until no call is left', async () => {
      mockAppState.currentState = 'background';
      const uuid = await ringingPush();
      callkeep.__emit('showIncomingCallUi', { callUUID: uuid, handle: '+15551234', name: 'Ada' });

      callkeep.__emit('answerCall', { callUUID: uuid });
      expect(mockIncomingCall.release).not.toHaveBeenCalled();

      bridge.registry.endCall(uuid);
      expect(mockIncomingCall.release).toHaveBeenCalledTimes(1);
    });

    it('replaces bringing the app forward from the push', async () => {
      // A background activity start, refused on Android 10+ and invisible
      // behind the lock screen; the notification is the sanctioned way.
      bridge.bringToForeground();
      expect(RNCallKeep.backToForeground).not.toHaveBeenCalled();
    });

    it('falls back to bringing the app forward without the native module', () => {
      mockNativeModuleLinked = false;
      bridge.bringToForeground();
      expect(RNCallKeep.backToForeground).toHaveBeenCalled();
    });
  });

  describe('a call Telecom refused', () => {
    it('is answered in the app through the SDK, not through a connection that does not exist', async () => {
      await bridge.setup({ appName: 'Demo' });
      const call = createCall('in-2');
      bridge.registry.attachIncomingCall(call as never);
      const uuid = bridge.registry.uuidForCall(call as never)!;

      callkeep.__emit('createIncomingConnectionFailed', {
        callUUID: uuid,
        handle: '+1',
        name: 'x'
      });

      expect(bridge.answerIncomingFromApp(call as never)).toBe(false);
      expect(bridge.rejectIncomingFromApp(call as never)).toBe(false);
      expect(RNCallKeep.answerIncomingCall).not.toHaveBeenCalled();
    });

    it('ends a push entry that has no call to answer instead', async () => {
      await bridge.setup({ appName: 'Demo' });
      const uuid = bridge.reportIncomingPush({ callId: 'c3', from: '+1', fromName: 'x' });

      callkeep.__emit('createIncomingConnectionFailed', {
        callUUID: uuid,
        handle: '+1',
        name: 'x'
      });

      expect(bridge.registry.entryForUuid(uuid)?.state).toBe('ended');
    });
  });
});
