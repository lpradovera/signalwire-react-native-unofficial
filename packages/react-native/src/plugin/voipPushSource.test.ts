/**
 * Contract tests for the generated PushKit hook.
 *
 * Jest cannot run Objective-C, so these pin the properties of the source text
 * that each fix depends on. The behaviour itself was checked by compiling the
 * generated file against the iOS SDK and driving it in a Mac Catalyst harness
 * (see the PR for this change).
 */
import { VOIP_PUSH_SOURCE } from './voipPushSource';

/** The source with every `#if DEBUG … #endif` block removed. */
function releaseOnly(source: string): string {
  return source.replace(/#if DEBUG[\s\S]*?#endif/g, '');
}

/** The body of the Objective-C method whose signature contains `selector`. */
function methodBody(source: string, selector: string): string {
  const start = source.indexOf(selector);
  if (start < 0) {
    return '';
  }
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) {
      return source.slice(open, i + 1);
    }
  }
  return '';
}

const pushHandler = (): string =>
  methodBody(VOIP_PUSH_SOURCE, 'didReceiveIncomingPushWithPayload:(PKPushPayload *)payload');

describe('generated SignalWireVoipPush.m', () => {
  describe('payload validation (plugins-11)', () => {
    it('reads no payload field without checking it is a string', () => {
      // `data[@"uuid"] ?: …` keeps an NSNumber or NSNull, and callkeep's
      // initWithUUIDString: throws on it inside the PushKit callback.
      expect(pushHandler()).not.toMatch(/data\[@"(uuid|call_id|from|from_name)"\]\s*\?:/);
      for (const key of ['call_id', 'from', 'from_name']) {
        expect(pushHandler()).toContain(`SWStringValue(data[@"${key}"])`);
      }
    });

    it('reports only a UUID that parses, lowercased as callkeep reports its actions', () => {
      // callkeep's answer/end events carry [UUIDString lowercaseString]; a
      // display uuid in any other case never matches them.
      expect(pushHandler()).toContain('SWCallUUID(data[@"uuid"])');
      const helper = methodBody(VOIP_PUSH_SOURCE, 'static NSString *SWCallUUID(');
      expect(helper).toContain('initWithUUIDString:');
      expect(helper).toContain('[NSUUID UUID]');
      expect(helper).toContain('lowercaseString');
    });
  });

  describe('logging (sweep-native-3)', () => {
    it('does not log the push token or call UUIDs outside DEBUG builds', () => {
      const release = releaseOnly(VOIP_PUSH_SOURCE);
      const logs = release.match(/NSLog\(@"[^"]*"[^;]*;/g) ?? [];
      expect(logs.length).toBeGreaterThan(0);
      for (const log of logs) {
        expect(log).not.toMatch(/\b(hex|token|uuid)\b\s*\)/);
      }
    });

    it('still logs the token in DEBUG builds', () => {
      expect(VOIP_PUSH_SOURCE).toMatch(/#if DEBUG\s+NSLog\(@"\[SignalWireVoipPush\] token %@", hex\);/);
    });
  });

  describe('token invalidation (plugins-15)', () => {
    it('drops the cached token when PushKit invalidates it', () => {
      const body = methodBody(VOIP_PUSH_SOURCE, 'didInvalidatePushTokenForType:(PKPushType)type');
      expect(body).toContain('setCachedToken:nil');
    });
  });

  describe('the cache shared with the module queue (plugins-16)', () => {
    it('uses no non-atomic associated objects', () => {
      expect(VOIP_PUSH_SOURCE).not.toContain('NONATOMIC');
    });

    it('guards every read and write of the cache with one lock', () => {
      for (const selector of [
        '+ (NSString *)cachedToken',
        '+ (void)setCachedToken:',
        '+ (NSArray<NSDictionary *> *)pendingCalls',
        '+ (void)addPendingCall:',
        '+ (void)removePendingCall:'
      ]) {
        expect(methodBody(VOIP_PUSH_SOURCE, selector)).toContain('@synchronized (SWCacheLock())');
      }
    });
  });

  describe('more than one push before JavaScript runs (sweep-native-2)', () => {
    it('keeps every pending call instead of one slot', () => {
      expect(pushHandler()).toContain('addPendingCall:');
      expect(VOIP_PUSH_SOURCE).not.toContain('setCachedCall');
    });

    it('lets JavaScript read them all and forget them one by one', () => {
      expect(VOIP_PUSH_SOURCE).toMatch(/RCT_EXPORT_METHOD\(getPendingCalls\b/);
      expect(VOIP_PUSH_SOURCE).toMatch(/RCT_EXPORT_METHOD\(forgetPendingCall\s*:\s*\(NSString \*\)uuid/);
    });

    it('bounds the cache, so an app that never reads it does not grow it forever', () => {
      expect(methodBody(VOIP_PUSH_SOURCE, '+ (void)addPendingCall:')).toContain('SWMaxPendingCalls');
    });
  });
});
