#import "SWAudioRoutes.h"

#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>

static NSString *const SWEarpiece = @"EARPIECE";
static NSString *const SWSpeaker = @"SPEAKER_PHONE";
static NSString *const SWWiredHeadset = @"WIRED_HEADSET";
static NSString *const SWBluetooth = @"BLUETOOTH";
static NSString *const SWDeviceChanged = @"onAudioDeviceChanged";

@implementation SWAudioRoutes {
  BOOL _observing;
  NSDictionary *_lastSent;
}

RCT_EXPORT_MODULE(SWAudioRoutes)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (NSArray<NSString *> *)supportedEvents
{
  return @[ SWDeviceChanged ];
}

- (void)startObserving
{
  _observing = YES;
  [[NSNotificationCenter defaultCenter] addObserver:self
                                           selector:@selector(routeChanged:)
                                               name:AVAudioSessionRouteChangeNotification
                                             object:nil];
}

- (void)stopObserving
{
  _observing = NO;
  [[NSNotificationCenter defaultCenter] removeObserver:self
                                                  name:AVAudioSessionRouteChangeNotification
                                                object:nil];
}

- (void)routeChanged:(NSNotification *)notification
{
  if (!_observing) {
    return;
  }
  // iOS posts route changes for category and mode changes too; only a change
  // in what the app can see is worth an event.
  NSDictionary *status = [self deviceStatus];
  @synchronized(self) {
    if ([status isEqualToDictionary:_lastSent]) {
      return;
    }
    _lastSent = status;
  }
  [self sendEventWithName:SWDeviceChanged body:status];
}

/** A port's route name, or nil for ports a call can't be routed to (AirPlay, HDMI, ...). */
- (NSString *)routeNameForPort:(AVAudioSessionPort)port
{
  if ([port isEqualToString:AVAudioSessionPortBuiltInReceiver]) {
    return SWEarpiece;
  }
  if ([port isEqualToString:AVAudioSessionPortBuiltInMic]) {
    // The built-in mic is how the receiver is chosen, on a device that has one.
    // An iPad has no receiver: its built-in mic and speaker are one route.
    return [UIDevice currentDevice].userInterfaceIdiom == UIUserInterfaceIdiomPhone ? SWEarpiece : SWSpeaker;
  }
  if ([port isEqualToString:AVAudioSessionPortBuiltInSpeaker]) {
    return SWSpeaker;
  }
  if ([port isEqualToString:AVAudioSessionPortHeadphones] || [port isEqualToString:AVAudioSessionPortHeadsetMic]) {
    return SWWiredHeadset;
  }
  if ([port isEqualToString:AVAudioSessionPortBluetoothHFP] || [port isEqualToString:AVAudioSessionPortBluetoothLE] ||
      [port isEqualToString:AVAudioSessionPortBluetoothA2DP] || [port isEqualToString:AVAudioSessionPortCarAudio]) {
    return SWBluetooth;
  }
  return nil;
}

- (AVAudioSessionPortDescription *)inputForRoute:(NSString *)route
{
  for (AVAudioSessionPortDescription *input in [AVAudioSession sharedInstance].availableInputs) {
    if ([[self routeNameForPort:input.portType] isEqualToString:route]) {
      return input;
    }
  }
  return nil;
}

/** The current output, if it belongs to `route`: an output-only device (A2DP, wired headphones without a mic). */
- (AVAudioSessionPortDescription *)currentOutputForRoute:(NSString *)route
{
  for (AVAudioSessionPortDescription *output in [AVAudioSession sharedInstance].currentRoute.outputs) {
    if ([[self routeNameForPort:output.portType] isEqualToString:route]) {
      return output;
    }
  }
  return nil;
}

- (NSDictionary *)deviceStatus
{
  AVAudioSession *session = [AVAudioSession sharedInstance];
  NSMutableArray<NSString *> *available = [NSMutableArray array];
  void (^add)(NSString *) = ^(NSString *name) {
    if (name != nil && ![available containsObject:name]) {
      [available addObject:name];
    }
  };
  for (AVAudioSessionPortDescription *input in session.availableInputs) {
    add([self routeNameForPort:input.portType]);
  }
  // Output-only devices have no input, so they show only while in use.
  for (AVAudioSessionPortDescription *output in session.currentRoute.outputs) {
    add([self routeNameForPort:output.portType]);
  }
  // The speaker is an output override, always there.
  add(SWSpeaker);
  AVAudioSessionPortDescription *output = session.currentRoute.outputs.firstObject;
  NSString *selected = output ? [self routeNameForPort:output.portType] : nil;
  NSData *json = [NSJSONSerialization dataWithJSONObject:available options:0 error:nil];
  return @{
    @"availableAudioDeviceList" : [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] ?: @"[]",
    @"selectedAudioDevice" : selected ?: @"",
    @"selectedAudioDeviceName" : output.portName ?: @"",
  };
}

RCT_EXPORT_METHOD(chooseAudioRoute:(NSString *)route
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  AVAudioSession *session = [AVAudioSession sharedInstance];
  NSError *error = nil;
  BOOL ok;
  if ([route isEqualToString:SWSpeaker]) {
    ok = [session overrideOutputAudioPort:AVAudioSessionPortOverrideSpeaker error:&error];
  } else {
    AVAudioSessionPortDescription *input = [self inputForRoute:route];
    // Only a headset or Bluetooth device can be output-only; the receiver
    // always comes with the built-in mic.
    BOOL outputOnly = [route isEqualToString:SWBluetooth] || [route isEqualToString:SWWiredHeadset];
    if (input == nil && !outputOnly) {
      reject(@"E_AUDIO_ROUTE_UNAVAILABLE", [NSString stringWithFormat:@"No %@ audio route is available", route], nil);
      return;
    }
    // Clear a speaker override, then prefer the route's input: iOS plays a call
    // through the output that goes with its input (the receiver with the
    // built-in mic, the headset with its own mic). An output-only device (A2DP,
    // headphones without a mic) has no input to prefer; it is the route once
    // the override is cleared, if it is connected at all.
    ok = [session overrideOutputAudioPort:AVAudioSessionPortOverrideNone error:&error] &&
         (input == nil || [session setPreferredInput:input error:&error]);
    if (ok && input == nil && [self currentOutputForRoute:route] == nil) {
      reject(@"E_AUDIO_ROUTE_UNAVAILABLE", [NSString stringWithFormat:@"No %@ audio route is available", route], nil);
      return;
    }
  }
  if (!ok) {
    reject(@"E_AUDIO_ROUTE", error.localizedDescription ?: @"Could not change the audio route", error);
    return;
  }
  resolve([self deviceStatus]);
}

RCT_EXPORT_METHOD(getAudioDeviceStatus:(RCTPromiseResolveBlock)resolve
                  rejecter:(__unused RCTPromiseRejectBlock)reject)
{
  resolve([self deviceStatus]);
}

@end
