import { NativeModules, Platform } from 'react-native';

import { donateCompletedCall, forgetSiriCalls, getSiriAuthorization, requestSiriAuthorization } from './siri';

jest.mock('react-native', () => ({ Platform: { OS: 'ios' }, NativeModules: {} }));

const modules = NativeModules as Record<string, unknown>;
const platform = Platform as { OS: string };

function linkModule() {
  const module = {
    donateCall: jest.fn(async () => true),
    authorizationStatus: jest.fn(async () => 'notDetermined'),
    requestAuthorization: jest.fn(async () => 'authorized'),
    forgetCalls: jest.fn(async () => true)
  };
  modules.SWSiriCalls = module;
  return module;
}

const CALL = {
  handle: '/private/rn-device-test',
  displayName: 'Rn Device Test',
  outgoing: true,
  video: false,
  startedAt: 1_000,
  endedAt: 31_000
};

describe('Siri call donations', () => {
  beforeEach(() => {
    platform.OS = 'ios';
    delete modules.SWSiriCalls;
  });

  it('donates a completed call with the remote party and its handle', async () => {
    const module = linkModule();
    await expect(donateCompletedCall(CALL)).resolves.toBe(true);
    expect(module.donateCall).toHaveBeenCalledWith({
      handle: '/private/rn-device-test',
      displayName: 'Rn Device Test',
      outgoing: true,
      video: false,
      startedAt: 1_000,
      endedAt: 31_000
    });
  });

  it('names an unnamed party by its handle, which is what Siri hears', async () => {
    const module = linkModule();
    await donateCompletedCall({ ...CALL, displayName: '  ', handle: ' +15551230000 ', outgoing: false });
    expect(module.donateCall).toHaveBeenCalledWith(
      expect.objectContaining({ handle: '+15551230000', displayName: '+15551230000', outgoing: false })
    );
  });

  it('donates nothing for a call with no one to call back', async () => {
    const module = linkModule();
    await expect(donateCompletedCall({ ...CALL, handle: 'Unknown' })).resolves.toBe(false);
    await expect(donateCompletedCall({ ...CALL, handle: '' })).resolves.toBe(false);
    expect(module.donateCall).not.toHaveBeenCalled();
  });

  it('is a no-op without the native module, and off iOS', async () => {
    await expect(donateCompletedCall(CALL)).resolves.toBe(false);
    await expect(getSiriAuthorization()).resolves.toBe('unavailable');
    await expect(requestSiriAuthorization()).resolves.toBe('unavailable');
    await expect(forgetSiriCalls()).resolves.toBeUndefined();

    const module = linkModule();
    platform.OS = 'android';
    await expect(donateCompletedCall(CALL)).resolves.toBe(false);
    await expect(requestSiriAuthorization()).resolves.toBe('unavailable');
    expect(module.donateCall).not.toHaveBeenCalled();
    expect(module.requestAuthorization).not.toHaveBeenCalled();
  });

  it('never rejects when the native side fails', async () => {
    const module = linkModule();
    module.donateCall.mockRejectedValueOnce(new Error('donation refused'));
    module.requestAuthorization.mockRejectedValueOnce(new Error('no entitlement'));
    module.forgetCalls.mockRejectedValueOnce(new Error('nope'));
    await expect(donateCompletedCall(CALL)).resolves.toBe(false);
    await expect(requestSiriAuthorization()).resolves.toBe('unavailable');
    await expect(forgetSiriCalls()).resolves.toBeUndefined();
  });

  it("passes Siri's authorization through, and maps anything else to unavailable", async () => {
    const module = linkModule();
    await expect(getSiriAuthorization()).resolves.toBe('notDetermined');
    await expect(requestSiriAuthorization()).resolves.toBe('authorized');
    module.authorizationStatus.mockResolvedValueOnce('something new');
    await expect(getSiriAuthorization()).resolves.toBe('unavailable');
  });

  it('forgets the donated calls', async () => {
    const module = linkModule();
    await forgetSiriCalls();
    expect(module.forgetCalls).toHaveBeenCalledTimes(1);
  });
});
