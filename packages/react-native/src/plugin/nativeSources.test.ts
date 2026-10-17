/**
 * Compiles the Siri and Recents Objective-C against the iOS Simulator SDK
 * (`clang -fsyntax-only`, ARC, every warning an error): the sources the config
 * plugin generates into the app target, and the pod's Siri files.
 *
 * React Native and callkeep are not built here, so the two headers those
 * files import are stubbed with the declarations they use. Needs Xcode;
 * skipped elsewhere, except where SW_REQUIRE_SWIFTC=1 (CI's macOS job) makes a
 * missing Xcode a failure.
 */
// Node built-ins, typed here: this package's tsconfig has no Node types
// (the same pattern as platform/androidWebRTCFieldTrials.test.ts).
declare const __dirname: string;
declare const process: { platform: string; env: Record<string, string | undefined> };
const { execFileSync, spawnSync } = require('child_process') as {
  execFileSync(file: string, args: string[], options?: { stdio: 'ignore' }): unknown;
  spawnSync(file: string, args: string[], options: { encoding: 'utf8' }): { stdout: string; stderr: string };
};
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('fs') as {
  mkdirSync(path: string, options?: { recursive: boolean }): void;
  mkdtempSync(prefix: string): string;
  rmSync(path: string, options?: { recursive: boolean; force: boolean }): void;
  writeFileSync(path: string, data: string): void;
};
const path = require('path') as { join(...parts: string[]): string };

import { CALLKIT_ACTIVITY_SOURCE } from './callKitActivitySource';
import { SIRI_INTENT_SOURCE } from './siriIntentSource';

const hasClang = (() => {
  if (process.platform !== 'darwin') {
    return false;
  }
  try {
    execFileSync('xcrun', ['--sdk', 'iphonesimulator', '--find', 'clang'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const required = process.env.SW_REQUIRE_SWIFTC === '1';
const describeNative = hasClang || required ? describe : describe.skip;

const IOS_DIR = path.join(__dirname, '..', '..', 'ios');
const REPO_TMP = path.join(__dirname, '..', '..', '..', '..', '.tmp');

const RCT_BRIDGE_MODULE_STUB = `#import <Foundation/Foundation.h>
typedef void (^RCTPromiseResolveBlock)(id result);
typedef void (^RCTPromiseRejectBlock)(NSString *code, NSString *message, NSError *error);
@protocol RCTBridgeModule <NSObject>
@end
#define RCT_EXPORT_MODULE(js_name) \\
  +(NSString *)moduleName { return @#js_name; }
#define RCT_EXPORT_METHOD(method) -(void)method
`;

const RNCALLKEEP_STUB = `#import <UIKit/UIKit.h>
@interface RNCallKeep : NSObject
+ (BOOL)application:(UIApplication *)application
    continueUserActivity:(NSUserActivity *)userActivity
      restorationHandler:(void (^)(NSArray *restorableObjects))restorationHandler;
@end
`;

describeNative('the Siri and Recents Objective-C', () => {
  let dir: string;

  beforeAll(() => {
    mkdirSync(REPO_TMP, { recursive: true });
    dir = mkdtempSync(path.join(REPO_TMP, 'native-sources-'));
    mkdirSync(path.join(dir, 'React'));
    writeFileSync(path.join(dir, 'React', 'RCTBridgeModule.h'), RCT_BRIDGE_MODULE_STUB);
    writeFileSync(path.join(dir, 'RNCallKeep.h'), RNCALLKEEP_STUB);
    writeFileSync(path.join(dir, 'SignalWireSiriCallIntent.m'), SIRI_INTENT_SOURCE);
    writeFileSync(path.join(dir, 'SignalWireCallKitActivity.m'), CALLKIT_ACTIVITY_SOURCE);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function compile(file: string): string[] {
    const result = spawnSync(
      'xcrun',
      [
        '--sdk',
        'iphonesimulator',
        'clang',
        '-fsyntax-only',
        '-fobjc-arc',
        '-fmodules',
        '-target',
        'arm64-apple-ios15.1-simulator',
        '-Wall',
        '-Wextra',
        '-Wno-unused-parameter',
        '-Werror',
        '-I',
        dir,
        '-I',
        IOS_DIR,
        file
      ],
      { encoding: 'utf8' }
    );
    return `${result.stdout}${result.stderr}`.split('\n').filter((line) => /(error|warning):/.test(line));
  }

  it('Xcode is available where the check is required', () => {
    expect(hasClang).toBe(true);
  });

  it.each(['SignalWireSiriCallIntent.m', 'SignalWireCallKitActivity.m'])('generated %s compiles cleanly', (file) => {
    expect(compile(path.join(dir, file))).toEqual([]);
  });

  it.each(['SWSiriCalls.m', 'SWSiriCallStore.m', 'SWSiriCallIntentHandler.m'])('ios/%s compiles cleanly', (file) => {
    expect(compile(path.join(IOS_DIR, file))).toEqual([]);
  });
});
