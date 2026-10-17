#import <Intents/Intents.h>
#import <React/RCTBridgeModule.h>

#import "SWSiriCallStore.h"

/**
 * Tells Siri about the app's calls (callkit/siri.ts).
 *
 * Each call that connected and ended is donated as an INInteraction with an
 * INStartCallIntent whose contact is the remote party: its display name, and
 * its SignalWire address as an INPersonHandle of unknown type (not a phone
 * number or an email, which iOS would try to match against Contacts). The
 * party also goes to the app's list of recent callees (SWSiriCallStore), which
 * the generated intent handler, SignalWireSiriCallIntent.m (the config
 * plugin's enableSiri), resolves "call <name> with <app>" against.
 *
 * Donating needs no entitlement. Siri's permission does: requesting it needs
 * NSSiriUsageDescription (iOS terminates an app that asks without it) and the
 * com.apple.developer.siri entitlement, both of which enableSiri adds.
 */
@interface SWSiriCalls : NSObject <RCTBridgeModule>
@end

static NSString *SWSiriStatusName(INSiriAuthorizationStatus status)
{
  switch (status) {
    case INSiriAuthorizationStatusAuthorized:
      return @"authorized";
    case INSiriAuthorizationStatusDenied:
      return @"denied";
    case INSiriAuthorizationStatusRestricted:
      return @"restricted";
    case INSiriAuthorizationStatusNotDetermined:
      return @"notDetermined";
  }
  return @"unavailable";
}

/** Whether this build has Siri configured: without the usage string, asking terminates the app. */
static BOOL SWSiriConfigured(void)
{
  id usage = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"NSSiriUsageDescription"];
  return [usage isKindOfClass:[NSString class]] && [(NSString *)usage length] > 0;
}

/**
 * The callees' names as Siri vocabulary, so a name Contacts does not have is
 * still recognised when spoken. Only once Siri is authorized: the vocabulary
 * belongs to Siri, and setting it needs the entitlement.
 */
static void SWSiriUpdateVocabulary(void)
{
  if (!SWSiriConfigured() || [INPreferences siriAuthorizationStatus] != INSiriAuthorizationStatusAuthorized) {
    return;
  }
  NSMutableOrderedSet<NSString *> *names = [NSMutableOrderedSet orderedSet];
  for (NSDictionary *callee in [SWSiriCallStore callees]) {
    NSString *name = callee[SWSiriCallStoreName];
    if (name.length > 0 && ![name isEqualToString:callee[SWSiriCallStoreHandle]]) {
      [names addObject:name];
    }
  }
  @try {
    [[INVocabulary sharedVocabulary] setVocabularyStrings:names ofType:INVocabularyStringTypeContactName];
  } @catch (NSException *exception) {
    NSLog(@"[SignalWireSiri] could not set the contact-name vocabulary: %@", exception.reason);
  }
}

@implementation SWSiriCalls

RCT_EXPORT_MODULE(SWSiriCalls)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

RCT_EXPORT_METHOD(donateCall:(NSDictionary *)call
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSString *handle = [call[@"handle"] isKindOfClass:[NSString class]] ? call[@"handle"] : @"";
  if (handle.length == 0) {
    resolve(@NO);
    return;
  }
  NSString *name = [call[@"displayName"] isKindOfClass:[NSString class]] && [call[@"displayName"] length] > 0
                       ? call[@"displayName"]
                       : handle;
  BOOL outgoing = [call[@"outgoing"] boolValue];
  BOOL video = [call[@"video"] boolValue];
  NSDate *start = [NSDate dateWithTimeIntervalSince1970:[call[@"startedAt"] doubleValue] / 1000.0];
  NSDate *end = [NSDate dateWithTimeIntervalSince1970:[call[@"endedAt"] doubleValue] / 1000.0];
  if ([end compare:start] == NSOrderedAscending) {
    end = start;
  }

  [SWSiriCallStore rememberHandle:handle name:name at:end];
  SWSiriUpdateVocabulary();

  INPerson *person = [SWSiriCallStore personForHandle:handle name:name];
  INStartCallIntent *intent =
      [[INStartCallIntent alloc] initWithCallRecordFilter:nil
                                     callRecordToCallBack:nil
                                               audioRoute:INCallAudioRouteUnknown
                                          destinationType:INCallDestinationTypeNormal
                                                 contacts:@[ person ]
                                           callCapability:video ? INCallCapabilityVideoCall : INCallCapabilityAudioCall];
  INInteraction *interaction = [[INInteraction alloc] initWithIntent:intent response:nil];
  interaction.direction = outgoing ? INInteractionDirectionOutgoing : INInteractionDirectionIncoming;
  interaction.dateInterval = [[NSDateInterval alloc] initWithStartDate:start endDate:end];
  // Grouped by handle, so a party's donations can be told apart from the rest.
  interaction.groupIdentifier = [@"signalwire-call:" stringByAppendingString:handle];

  [interaction donateInteractionWithCompletion:^(NSError *_Nullable error) {
    if (error != nil) {
      NSLog(@"[SignalWireSiri] donation for %@ failed: %@", handle, error);
      resolve(@NO);
      return;
    }
    NSLog(@"[SignalWireSiri] donated a %@ call with %@ (%@)", outgoing ? @"outgoing" : @"incoming", name, handle);
    resolve(@YES);
  }];
}

RCT_EXPORT_METHOD(authorizationStatus:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  if (!SWSiriConfigured()) {
    resolve(@"unavailable");
    return;
  }
  resolve(SWSiriStatusName([INPreferences siriAuthorizationStatus]));
}

RCT_EXPORT_METHOD(requestAuthorization:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  if (!SWSiriConfigured()) {
    NSLog(@"[SignalWireSiri] not asking for Siri: no NSSiriUsageDescription (the config plugin's enableSiri)");
    resolve(@"unavailable");
    return;
  }
  @try {
    [INPreferences requestSiriAuthorization:^(INSiriAuthorizationStatus status) {
      if (status == INSiriAuthorizationStatusAuthorized) {
        SWSiriUpdateVocabulary();
      }
      resolve(SWSiriStatusName(status));
    }];
  } @catch (NSException *exception) {
    // A build signed without the com.apple.developer.siri entitlement.
    NSLog(@"[SignalWireSiri] requestSiriAuthorization failed: %@", exception.reason);
    resolve(@"unavailable");
  }
}

RCT_EXPORT_METHOD(forgetCalls:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [SWSiriCallStore forgetAll];
  SWSiriUpdateVocabulary();
  [INInteraction deleteAllInteractionsWithCompletion:^(NSError *_Nullable error) {
    if (error != nil) {
      NSLog(@"[SignalWireSiri] deleting the donations failed: %@", error);
      resolve(@NO);
      return;
    }
    resolve(@YES);
  }];
}

@end
