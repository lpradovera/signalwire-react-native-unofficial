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
});
