import { SIRI_INTENT_SOURCE } from './siriIntentSource';

describe('the generated Siri call intent handler', () => {
  it("gives the AppDelegate application:handlerForIntent: for INStartCallIntent, with the pod's handler", () => {
    expect(SIRI_INTENT_SOURCE).toContain('@selector(application:handlerForIntent:)');
    expect(SIRI_INTENT_SOURCE).toContain('[intent isKindOfClass:[INStartCallIntent class]]');
    // Looked up by name: the app target does not see the pod's headers.
    expect(SIRI_INTENT_SOURCE).toContain('NSClassFromString(@"SWSiriCallIntentHandler")');
    expect(SIRI_INTENT_SOURCE).not.toMatch(/#import "SW/);
  });

  it("keeps the AppDelegate's own handler for every other intent", () => {
    expect(SIRI_INTENT_SOURCE).toContain('class_addMethod');
    expect(SIRI_INTENT_SOURCE).toContain('method_setImplementation');
    expect(SIRI_INTENT_SOURCE).toContain('SignalWireOriginalHandler(self, _cmd, application, intent)');
  });

  it('says so when the app has no multiple scenes, where iOS never asks it', () => {
    expect(SIRI_INTENT_SOURCE).toContain('UIApplicationSupportsMultipleScenes');
  });

  it('installs itself without a line in the Swift AppDelegate', () => {
    expect(SIRI_INTENT_SOURCE).toContain('UIApplicationDidFinishLaunchingNotification');
    expect(SIRI_INTENT_SOURCE).toContain('+ (void)load');
  });
});
