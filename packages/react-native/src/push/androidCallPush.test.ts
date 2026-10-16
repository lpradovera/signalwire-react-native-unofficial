/**
 * Android call push, from an FCM data message to a native incoming call.
 *
 * Firebase is the real RNFB 22.4.0 JavaScript with its native side stubbed
 * (`jest/rnfb.ts`); the bridge is spied on. The background path is driven the
 * way Android drives it: RNFB's headless task, which its native service starts
 * for a data message while the app is backgrounded or killed.
 */
import type { RnfbNativeState } from '../../jest/rnfb';

const mockNative: RnfbNativeState = { apps: [], calls: [] };

jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  const { installRnfbNatives } = jest.requireActual('../../jest/rnfb');
  Object.defineProperty(RN.Platform, 'OS', { configurable: true, get: () => 'android' });
  Object.defineProperty(RN.Platform, 'Version', { configurable: true, get: () => 34 });
  installRnfbNatives(RN.NativeModules, mockNative);
  return RN;
});


type HeadlessTask = (message: unknown) => Promise<void>;

interface Loaded {
  push: typeof import('./androidCallPush');
  bridge: { reportIncomingPush: jest.Mock; bringToForeground: jest.Mock };
  headlessTask: () => HeadlessTask | undefined;
  emitForeground: (message: unknown) => void;
}

function load(): Loaded {
  jest.resetModules();
  const RN = require('react-native');
  const tasks = new Map<string, () => HeadlessTask>();
  jest.spyOn(RN.AppRegistry, 'registerHeadlessTask').mockImplementation((...args: unknown[]) => {
    tasks.set(args[0] as string, args[1] as () => HeadlessTask);
  });
  const bridge = { reportIncomingPush: jest.fn(() => 'uuid-1'), bringToForeground: jest.fn() };
  jest.doMock('../callkit/CallKeepBridge', () => ({ getCallKit: () => bridge }));
  return {
    push: require('./androidCallPush'),
    bridge,
    headlessTask: () => tasks.get('ReactNativeFirebaseMessagingHeadlessTask')?.(),
    // RNFB's native module emits on the device event emitter, prefixed.
    emitForeground: (message) =>
      RN.DeviceEventEmitter.emit('rnfb_messaging_message_received', message)
  };
}

/** What the server sends: FCM-reserved keys renamed with `sw_`. */
const CALL_PUSH = {
  data: {
    call_id: 'call-1',
    sw_from: '+15551234567',
    from_name: 'Ada',
    bridgeToken: 'tok-1'
  }
};

beforeEach(() => {
  mockNative.apps = [require('../../jest/rnfb').DEFAULT_FIREBASE_APP];
  mockNative.calls = [];
});

describe('registerAndroidCallPush', () => {
  it('reports a call push delivered to the headless task (backgrounded or killed app)', async () => {
    const { push, bridge, headlessTask } = load();
    push.registerAndroidCallPush();

    const task = headlessTask();
    expect(task).toBeDefined();
    await task?.(CALL_PUSH);

    expect(bridge.reportIncomingPush).toHaveBeenCalledTimes(1);
    expect(bridge.reportIncomingPush).toHaveBeenCalledWith({
      callId: 'call-1',
      from: '+15551234567',
      fromName: 'Ada',
      data: { bridgeToken: 'tok-1' }
    });
  });

  it('reports a call push delivered while the app is in the foreground', () => {
    const { push, bridge, emitForeground } = load();
    push.registerAndroidCallPush();

    emitForeground(CALL_PUSH);

    expect(bridge.reportIncomingPush).toHaveBeenCalledTimes(1);
    expect(bridge.reportIncomingPush.mock.calls[0]?.[0]).toMatchObject({ callId: 'call-1' });
  });

  it('ignores a data message that is not a call', async () => {
    const { push, bridge, headlessTask } = load();
    push.registerAndroidCallPush();

    const task = headlessTask();
    expect(task).toBeDefined();
    await task?.({ data: { kind: 'chat' } });

    expect(bridge.reportIncomingPush).not.toHaveBeenCalled();
  });

  it('survives a build that links Firebase but has no google-services.json', () => {
    // RNFB's getMessaging() throws "No Firebase App '[DEFAULT]' has been
    // created". This runs in the app's entry file: a throw here stops
    // registerRootComponent and the app never starts.
    mockNative.apps = [];
    const { push } = load();

    expect(() => push.registerAndroidCallPush()).not.toThrow();
  });
});

describe('decodePushData', () => {
  it('restores keys the sender had to rename for FCM', () => {
    // FCM rejects `from` in a data payload, failing the whole message, so the
    // server sends `sw_from`. Both platforms must hand the registry the same
    // shape or the caller id silently goes missing on one of them.
    const { push } = load();
    const decoded = push.decodePushData({
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
    expect(load().push.decodePushData({ bridgeToken: 'tok-2' }).bridgeToken).toBe('tok-2');
  });

  it("leaves an app's own sw_ keys alone; only the reserved ones were renamed", () => {
    expect(load().push.decodePushData({ sw_region: 'eu', sw_to: 'x' })).toEqual({
      sw_region: 'eu',
      to: 'x'
    });
  });

  it('leaves an already-plain payload alone', () => {
    expect(load().push.decodePushData({ from: 'x' })).toEqual({ from: 'x' });
  });
});
