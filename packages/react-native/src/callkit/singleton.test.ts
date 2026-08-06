import { resetAudioRouteControllerForTesting } from '../audio/AudioRouteController';
import { resetCallKitForTesting } from './CallKeepBridge';

/**
 * tsup builds each subpath entry self-contained, so CallKeepBridge.ts exists
 * twice in dist — once in the root bundle, once in `/callkit`. Two module
 * scopes meant two "singletons": setup() ran on one while the registry lived
 * on the other, and inbound calls connected with no audio. `jest.isolateModules`
 * reproduces exactly that: two independent copies of the module. The instance
 * must survive it.
 */
describe('cross-bundle singletons', () => {
  afterEach(() => {
    resetCallKitForTesting();
    resetAudioRouteControllerForTesting();
  });

  it('getCallKit returns one instance across duplicated module copies', () => {
    let first: unknown;
    let second: unknown;
    jest.isolateModules(() => {
      first = require('./CallKeepBridge').getCallKit();
    });
    jest.isolateModules(() => {
      second = require('./CallKeepBridge').getCallKit();
    });
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it('getAudioRouteController returns one instance across duplicated module copies', () => {
    let first: unknown;
    let second: unknown;
    jest.isolateModules(() => {
      first = require('../audio/AudioRouteController').getAudioRouteController();
    });
    jest.isolateModules(() => {
      second = require('../audio/AudioRouteController').getAudioRouteController();
    });
    expect(second).toBe(first);
  });
});
