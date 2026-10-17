#import <React/RCTBridgeModule.h>
#import <objc/message.h>

/**
 * WebRTC's manual-audio switches (RTCAudioSession.useManualAudio and
 * isAudioEnabled), which react-native-webrtc does not expose to JavaScript.
 * The bridge (callkit/webrtcAudioSession.ts) turns manual audio on and runs
 * WebRTC's audio unit only while CallKit has the audio session active,
 * restarting it on each activation; see that file for why.
 *
 * RTCAudioSession is looked up at run time, not linked: this pod then needs
 * no dependency on a particular WebRTC build (JitsiWebRTC 124 or 155, or
 * another), and an app without one gets `NO` from every method.
 */
@interface SWWebRTCAudioSession : NSObject <RCTBridgeModule>
@end

static id SWSharedRTCAudioSession(void)
{
  Class cls = NSClassFromString(@"RTCAudioSession");
  SEL shared = NSSelectorFromString(@"sharedInstance");
  if (cls == Nil || ![cls respondsToSelector:shared]) {
    return nil;
  }
  return ((id (*)(id, SEL))objc_msgSend)(cls, shared);
}

static BOOL SWGetBool(id target, NSString *getter)
{
  SEL sel = NSSelectorFromString(getter);
  if (![target respondsToSelector:sel]) {
    return NO;
  }
  return ((BOOL (*)(id, SEL))objc_msgSend)(target, sel);
}

static BOOL SWSetBool(id target, NSString *setter, BOOL value)
{
  SEL sel = NSSelectorFromString(setter);
  if (![target respondsToSelector:sel]) {
    return NO;
  }
  ((void (*)(id, SEL, BOOL))objc_msgSend)(target, sel, value);
  return YES;
}

@implementation SWWebRTCAudioSession

RCT_EXPORT_MODULE(SWWebRTCAudioSession)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

/**
 * Turns manual audio on. The first time, audio is enabled only if WebRTC's
 * session is already active (a JavaScript reload in the middle of a call, the
 * native state having outlived it); otherwise it waits for CallKit's first
 * activation. Already on, nothing changes. YES when WebRTC is present.
 */
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(useManualAudio)
{
  id session = SWSharedRTCAudioSession();
  if (session == nil) {
    return @NO;
  }
  if (!SWGetBool(session, @"useManualAudio")) {
    SWSetBool(session, @"setIsAudioEnabled:", SWGetBool(session, @"isActive"));
    if (!SWSetBool(session, @"setUseManualAudio:", YES)) {
      return @NO;
    }
  }
  return @YES;
}

/** Starts (YES) or stops and uninitializes (NO) WebRTC's audio unit under manual audio. */
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(setAudioEnabled:(BOOL)enabled)
{
  id session = SWSharedRTCAudioSession();
  if (session == nil) {
    return @NO;
  }
  return @(SWSetBool(session, @"setIsAudioEnabled:", enabled));
}

/** Gives WebRTC back its automatic audio: it runs its unit whenever a call needs it. */
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(useAutomaticAudio)
{
  id session = SWSharedRTCAudioSession();
  if (session == nil) {
    return @NO;
  }
  return @(SWSetBool(session, @"setUseManualAudio:", NO));
}

@end
