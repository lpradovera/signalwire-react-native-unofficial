import { CALLKIT_ACTIVITY_SOURCE } from './callKitActivitySource';

describe('the generated continueUserActivity forwarder', () => {
  it('hands call intents to RNCallKeep from the AppDelegate', () => {
    expect(CALLKIT_ACTIVITY_SOURCE).toContain('#import "RNCallKeep.h"');
    expect(CALLKIT_ACTIVITY_SOURCE).toContain(
      '[RNCallKeep application:application continueUserActivity:activity restorationHandler:handler]'
    );
    expect(CALLKIT_ACTIVITY_SOURCE).toContain('@selector(application:continueUserActivity:restorationHandler:)');
    for (const type of ['INStartCallIntent', 'INStartAudioCallIntent', 'INStartVideoCallIntent']) {
      expect(CALLKIT_ACTIVITY_SOURCE).toContain(type);
    }
  });

  it("keeps the AppDelegate's own handler (universal links, Expo's subscribers)", () => {
    // Added to the class when it has no method of its own, replaced (and the
    // original called) when it has one: never dropped.
    expect(CALLKIT_ACTIVITY_SOURCE).toContain('class_addMethod');
    expect(CALLKIT_ACTIVITY_SOURCE).toContain('method_setImplementation');
    expect(CALLKIT_ACTIVITY_SOURCE).toMatch(/return handled \|\| original;/);
  });

  it('installs itself without a line in the Swift AppDelegate', () => {
    expect(CALLKIT_ACTIVITY_SOURCE).toContain('UIApplicationDidFinishLaunchingNotification');
    expect(CALLKIT_ACTIVITY_SOURCE).toContain('+ (void)load');
  });
});
