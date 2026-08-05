const InCallManager = {
  start: jest.fn(),
  stop: jest.fn(),
  setForceSpeakerphoneOn: jest.fn(),
  chooseAudioRoute: jest.fn(async () => undefined),
  setSpeakerphoneOn: jest.fn()
};

export default InCallManager;
