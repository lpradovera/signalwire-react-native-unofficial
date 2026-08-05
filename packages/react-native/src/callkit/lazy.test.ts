import { loadCallKit } from './lazy';

/**
 * The lazy require is what keeps `react-native-callkeep` out of Metro's graph
 * for apps that never enable native call UI, so it is worth pinning down.
 */
describe('loadCallKit', () => {
  it('returns the CallKit bridge singleton', () => {
     
    const { getCallKit, resetCallKitForTesting } =
      require('./CallKeepBridge') as typeof import('./CallKeepBridge');

    try {
      expect(loadCallKit()).toBe(getCallKit());
    } finally {
      resetCallKitForTesting();
    }
  });

  it('returns the same instance across calls', () => {
     
    const { resetCallKitForTesting } = require('./CallKeepBridge') as typeof import('./CallKeepBridge');
    try {
      expect(loadCallKit()).toBe(loadCallKit());
    } finally {
      resetCallKitForTesting();
    }
  });
});
