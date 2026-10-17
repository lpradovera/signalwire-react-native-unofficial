#import "SWSiriCallStore.h"

NSString *const SWSiriCallStoreHandle = @"handle";
NSString *const SWSiriCallStoreName = @"name";
static NSString *const SWSiriCallStoreAt = @"at";
static NSString *const SWSiriCallStoreKey = @"SignalWireSiriCallees";
static const NSUInteger SWSiriCallStoreLimit = 50;

/** Lower case, without accents, words separated by single spaces. */
static NSString *SWSiriNormalize(NSString *text)
{
  NSString *folded = [text stringByFoldingWithOptions:NSCaseInsensitiveSearch | NSDiacriticInsensitiveSearch
                                               locale:nil];
  NSArray<NSString *> *parts =
      [folded componentsSeparatedByCharactersInSet:[[NSCharacterSet alphanumericCharacterSet] invertedSet]];
  NSMutableArray<NSString *> *words = [NSMutableArray array];
  for (NSString *part in parts) {
    if (part.length > 0) {
      [words addObject:part];
    }
  }
  return [words componentsJoinedByString:@" "];
}

@implementation SWSiriCallStore

+ (NSArray<NSDictionary *> *)callees
{
  NSArray *stored = [[NSUserDefaults standardUserDefaults] arrayForKey:SWSiriCallStoreKey];
  NSMutableArray<NSDictionary *> *callees = [NSMutableArray array];
  for (id entry in stored) {
    if ([entry isKindOfClass:[NSDictionary class]] && [entry[SWSiriCallStoreHandle] isKindOfClass:[NSString class]] &&
        [entry[SWSiriCallStoreName] isKindOfClass:[NSString class]]) {
      [callees addObject:entry];
    }
  }
  return callees;
}

+ (void)rememberHandle:(NSString *)handle name:(NSString *)name at:(NSDate *)date
{
  @synchronized(self) {
    NSMutableArray<NSDictionary *> *callees = [NSMutableArray array];
    [callees addObject:@{
      SWSiriCallStoreHandle : handle,
      SWSiriCallStoreName : name.length > 0 ? name : handle,
      SWSiriCallStoreAt : @(date.timeIntervalSince1970)
    }];
    for (NSDictionary *callee in [self callees]) {
      if (![callee[SWSiriCallStoreHandle] isEqualToString:handle] && callees.count < SWSiriCallStoreLimit) {
        [callees addObject:callee];
      }
    }
    [[NSUserDefaults standardUserDefaults] setObject:callees forKey:SWSiriCallStoreKey];
  }
}

+ (void)forgetAll
{
  @synchronized(self) {
    [[NSUserDefaults standardUserDefaults] removeObjectForKey:SWSiriCallStoreKey];
  }
}

+ (INPerson *)personForHandle:(NSString *)handle name:(NSString *)name
{
  INPersonHandle *personHandle = [[INPersonHandle alloc] initWithValue:handle type:INPersonHandleTypeUnknown];
  return [[INPerson alloc] initWithPersonHandle:personHandle
                                 nameComponents:nil
                                    displayName:name.length > 0 ? name : handle
                                          image:nil
                              contactIdentifier:nil
                               customIdentifier:handle];
}

+ (NSArray<NSDictionary *> *)calleesMatchingName:(NSString *)spoken
{
  NSString *wanted = SWSiriNormalize(spoken ?: @"");
  if (wanted.length == 0) {
    return @[];
  }
  NSArray<NSString *> *wantedWords = [wanted componentsSeparatedByString:@" "];
  NSMutableArray<NSDictionary *> *exact = [NSMutableArray array];
  NSMutableArray<NSDictionary *> *partial = [NSMutableArray array];
  for (NSDictionary *callee in [self callees]) {
    NSString *name = SWSiriNormalize(callee[SWSiriCallStoreName]);
    if ([name isEqualToString:wanted] || [SWSiriNormalize(callee[SWSiriCallStoreHandle]) isEqualToString:wanted]) {
      [exact addObject:callee];
      continue;
    }
    NSSet<NSString *> *words = [NSSet setWithArray:[name componentsSeparatedByString:@" "]];
    BOOL all = YES;
    for (NSString *word in wantedWords) {
      if (![words containsObject:word]) {
        all = NO;
        break;
      }
    }
    if (all) {
      [partial addObject:callee];
    }
  }
  return exact.count > 0 ? exact : partial;
}

+ (nullable NSDictionary *)calleeWithHandle:(NSString *)handle
{
  for (NSDictionary *callee in [self callees]) {
    if ([callee[SWSiriCallStoreHandle] isEqualToString:handle]) {
      return callee;
    }
  }
  return nil;
}

@end
