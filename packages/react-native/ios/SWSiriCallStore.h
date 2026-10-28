#import <Foundation/Foundation.h>
#import <Intents/Intents.h>

NS_ASSUME_NONNULL_BEGIN

extern NSString *const SWSiriCallStoreHandle;
extern NSString *const SWSiriCallStoreName;

/**
 * The app's recent callees, newest first: the people Siri can call through the
 * app by name. Written by SWSiriCalls for each completed call, read by
 * SWSiriCallIntentHandler. Kept in the app's standard user defaults: in-app
 * intent handling runs in the app's own process.
 */
@interface SWSiriCallStore : NSObject

/** Each callee as {handle, name, at (seconds since 1970)}, newest first. */
+ (NSArray<NSDictionary *> *)callees;

/** Adds or refreshes a callee, keeping the newest 50. */
+ (void)rememberHandle:(NSString *)handle name:(NSString *)name at:(NSDate *)date;

+ (void)forgetAll;

/** An INPerson Siri and callkeep can dial: the handle as an INPersonHandle of unknown type. */
+ (INPerson *)personForHandle:(NSString *)handle name:(NSString *)name;

/**
 * The callees whose name matches what the user said: every word of the spoken
 * name, ignoring case, accents and punctuation. Exact matches win over partial
 * ones; one entry per handle.
 */
+ (NSArray<NSDictionary *> *)calleesMatchingName:(NSString *)spoken;

/** The callee with this handle, if any. */
+ (nullable NSDictionary *)calleeWithHandle:(NSString *)handle;

@end

NS_ASSUME_NONNULL_END
