#import <Foundation/Foundation.h>
#import <Intents/Intents.h>

#import "SWSiriCallStore.h"

/**
 * Siri's "call <name> with <app>" and "call back" for the app's own callees.
 *
 * Handed to Siri by the app delegate's application:handlerForIntent:, which
 * the config plugin's enableSiri adds (SignalWireSiriCallIntent.m, looked up
 * by name so this pod needs nothing from the app). A spoken name is resolved
 * against the app's recent callees (SWSiriCallStore): a name becomes callable
 * after the first call with it. A person Siri already resolved to a handle (a
 * contact card, a donated interaction) is taken as it is.
 *
 * The call is not placed here. The handle step answers continueInApp, so iOS
 * opens the app with an INStartCallIntent user activity, which the generated
 * continueUserActivity forwarder hands to RNCallKeep: the same path as a
 * Recents call-back, ending in the bridge's startCallRequested$.
 */
@interface SWSiriCallIntentHandler : NSObject <INStartCallIntentHandling>
@end

static BOOL SWSiriIsRedial(INStartCallIntent *intent)
{
  return intent.destinationType == INCallDestinationTypeRedial || intent.callRecordToCallBack != nil ||
         intent.callRecordFilter != nil;
}

static INPerson *SWSiriPersonFor(NSDictionary *callee)
{
  return [SWSiriCallStore personForHandle:callee[SWSiriCallStoreHandle] name:callee[SWSiriCallStoreName]];
}

/** The callee a call-back means: the record's participant if it is one of ours, else the newest. */
static NSDictionary *SWSiriCalleeToCallBack(INStartCallIntent *intent)
{
  for (INPerson *participant in intent.callRecordToCallBack.participants) {
    NSString *handle = participant.personHandle.value;
    NSDictionary *callee = handle.length > 0 ? [SWSiriCallStore calleeWithHandle:handle] : nil;
    if (callee != nil) {
      return callee;
    }
  }
  return [SWSiriCallStore callees].firstObject;
}

static INStartCallContactResolutionResult *SWSiriResolve(INPerson *person)
{
  // Siri resolved it already: a donated interaction, or a contact card.
  for (NSString *handle in @[ person.customIdentifier ?: @"", person.personHandle.value ?: @"" ]) {
    NSDictionary *callee = handle.length > 0 ? [SWSiriCallStore calleeWithHandle:handle] : nil;
    if (callee != nil) {
      return [INStartCallContactResolutionResult successWithResolvedPerson:SWSiriPersonFor(callee)];
    }
  }
  if (person.personHandle.value.length > 0) {
    return [INStartCallContactResolutionResult successWithResolvedPerson:person];
  }

  NSString *spoken = person.displayName.length > 0 ? person.displayName
                                                   : [NSPersonNameComponentsFormatter
                                                         localizedStringFromPersonNameComponents:person.nameComponents
                                                                                           style:NSPersonNameComponentsFormatterStyleDefault
                                                                                         options:0];
  NSArray<NSDictionary *> *matches = [SWSiriCallStore calleesMatchingName:spoken];
  NSLog(@"[SignalWireSiri] \"%@\": %lu matching callee(s)", spoken, (unsigned long)matches.count);
  if (matches.count == 1) {
    return [INStartCallContactResolutionResult successWithResolvedPerson:SWSiriPersonFor(matches.firstObject)];
  }
  if (matches.count > 1) {
    NSMutableArray<INPerson *> *people = [NSMutableArray array];
    for (NSDictionary *callee in matches) {
      [people addObject:SWSiriPersonFor(callee)];
    }
    return [INStartCallContactResolutionResult disambiguationWithPeopleToDisambiguate:people];
  }
  return [INStartCallContactResolutionResult unsupported];
}

@implementation SWSiriCallIntentHandler

- (void)resolveContactsForStartCall:(INStartCallIntent *)intent
                     withCompletion:(void (^)(NSArray<INStartCallContactResolutionResult *> *))completion
{
  NSArray<INPerson *> *contacts = intent.contacts ?: @[];
  if (contacts.count == 0) {
    NSDictionary *callee = SWSiriIsRedial(intent) ? SWSiriCalleeToCallBack(intent) : nil;
    if (callee != nil) {
      NSLog(@"[SignalWireSiri] call-back: %@", callee[SWSiriCallStoreHandle]);
      completion(@[ [INStartCallContactResolutionResult successWithResolvedPerson:SWSiriPersonFor(callee)] ]);
    } else {
      completion(@[ [INStartCallContactResolutionResult needsValue] ]);
    }
    return;
  }
  if (contacts.count > 1) {
    // One person per call: a conference is not something the app places.
    completion(@[ [INStartCallContactResolutionResult unsupported] ]);
    return;
  }
  completion(@[ SWSiriResolve(contacts.firstObject) ]);
}

- (void)resolveCallCapabilityForStartCall:(INStartCallIntent *)intent
                           withCompletion:(void (^)(INStartCallCallCapabilityResolutionResult *))completion
{
  // RNCallKeep reads the capability to find the contact: unknown would drop the call-back.
  INCallCapability capability =
      intent.callCapability == INCallCapabilityVideoCall ? INCallCapabilityVideoCall : INCallCapabilityAudioCall;
  completion([INStartCallCallCapabilityResolutionResult successWithResolvedCallCapability:capability]);
}

- (void)resolveDestinationTypeForStartCall:(INStartCallIntent *)intent
                            withCompletion:(void (^)(INCallDestinationTypeResolutionResult *))completion
{
  switch (intent.destinationType) {
    case INCallDestinationTypeUnknown:
    case INCallDestinationTypeNormal:
      completion([INCallDestinationTypeResolutionResult successWithResolvedCallDestinationType:INCallDestinationTypeNormal]);
      return;
    case INCallDestinationTypeRedial:
      completion([INCallDestinationTypeResolutionResult successWithResolvedCallDestinationType:INCallDestinationTypeRedial]);
      return;
    default:
      // Emergency services and voicemail are not the app's to call.
      completion([INCallDestinationTypeResolutionResult unsupported]);
      return;
  }
}

- (void)confirmStartCall:(INStartCallIntent *)intent
              completion:(void (^)(INStartCallIntentResponse *))completion
{
  BOOL dialable = intent.contacts.firstObject.personHandle.value.length > 0;
  completion([[INStartCallIntentResponse alloc] initWithCode:dialable ? INStartCallIntentResponseCodeReady
                                                                      : INStartCallIntentResponseCodeFailure
                                                userActivity:nil]);
}

- (void)handleStartCall:(INStartCallIntent *)intent
             completion:(void (^)(INStartCallIntentResponse *))completion
{
  NSLog(@"[SignalWireSiri] calling %@ in the app", intent.contacts.firstObject.personHandle.value);
  NSUserActivity *activity = [[NSUserActivity alloc] initWithActivityType:NSStringFromClass([INStartCallIntent class])];
  completion([[INStartCallIntentResponse alloc] initWithCode:INStartCallIntentResponseCodeContinueInApp
                                                userActivity:activity]);
}

@end
