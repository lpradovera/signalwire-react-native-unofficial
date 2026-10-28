const InCallManager = {
  start: jest.fn(),
  stop: jest.fn(),
  setForceSpeakerphoneOn: jest.fn(),
  chooseAudioRoute: jest.fn(async () => undefined),
  setKeepScreenOn: jest.fn(),
  startProximitySensor: jest.fn(),
  stopProximitySensor: jest.fn(),
  turnScreenOn: jest.fn(),
  turnScreenOff: jest.fn()
};

export default InCallManager;
