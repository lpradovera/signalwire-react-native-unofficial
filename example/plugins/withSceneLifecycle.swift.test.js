/**
 * Type-checks the AppDelegate.swift withSceneLifecycle generates, against the
 * iOS SDK, under the Swift settings an app can use: Swift 5 (Expo's template),
 * Swift 5 with complete concurrency checking, Swift 6, and Xcode 27's settings
 * for a new app (main-actor default isolation, approachable concurrency).
 *
 * Expo and React Native are not built here, so the few of their types the
 * template uses are stubbed with the signatures they have in Expo SDK 54 and
 * React Native 0.81. Needs Xcode; skipped elsewhere.
 */
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, test } = require('node:test');

const withSceneLifecycle = require('./withSceneLifecycle');
const { makeProject, prebuild, removeProjects } = require('./test/prebuild');

after(removeProjects);

const hasSwiftc = (() => {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('xcrun', ['--sdk', 'iphonesimulator', '--find', 'swiftc'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const skip = !hasSwiftc && 'needs Xcode (xcrun swiftc)';

const STUBS = `import UIKit

// Stand-ins for the Expo and React Native types Expo SDK 54's AppDelegate uses.
open class RCTBridge: NSObject {
  public var bundleURL: URL?
}

open class RCTReactNativeFactory: NSObject {
  public func startReactNative(withModuleName moduleName: String, in window: UIWindow?, launchOptions: [AnyHashable: Any]? = nil) {}
}

open class RCTAppDependencyProvider: NSObject {}

open class RCTBundleURLProvider: NSObject {
  public static func sharedSettings() -> RCTBundleURLProvider { RCTBundleURLProvider() }
  public func jsBundleURL(forBundleRoot bundleRoot: String) -> URL? { nil }
}

open class RCTLinkingManager: NSObject {
  public static func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool { true }
  public static func application(_ application: UIApplication, continue userActivity: NSUserActivity,
                                 restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool { true }
}

open class ExpoReactNativeFactoryDelegate: NSObject {
  public var dependencyProvider: RCTAppDependencyProvider?
  open func sourceURL(for bridge: RCTBridge) -> URL? { nil }
  open func bundleURL() -> URL? { nil }
}

public class ExpoReactNativeFactory: RCTReactNativeFactory {
  public init(delegate: ExpoReactNativeFactoryDelegate) {}
}

open class ExpoAppDelegate: UIResponder, UIApplicationDelegate {
  public func bindReactNativeFactory(_ factory: RCTReactNativeFactory) {}
  open func application(_ application: UIApplication,
                        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool { true }
  open func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool { false }
  open func application(_ application: UIApplication, continue userActivity: NSUserActivity,
                        restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool { false }
}
`;

const MODES = {
  'Swift 5': ['-swift-version', '5'],
  'Swift 5, complete concurrency checking': ['-swift-version', '5', '-strict-concurrency=complete'],
  'Swift 6': ['-swift-version', '6'],
  "Xcode 27's new-app settings": [
    '-swift-version', '5',
    '-default-isolation', 'MainActor',
    '-enable-upcoming-feature', 'NonisolatedNonsendingByDefault',
    '-enable-upcoming-feature', 'InferIsolatedConformances',
    '-enable-upcoming-feature', 'InferSendableFromCaptures',
    '-enable-upcoming-feature', 'GlobalActorIsolatedTypesUsability',
    '-enable-upcoming-feature', 'DisableOutwardActorInference'
  ]
};

let source;
let dir;

before(async () => {
  if (skip) return;
  const root = makeProject('swift');
  const { appDelegate } = await prebuild(root, [withSceneLifecycle]);
  // @UIApplicationMain is an error in Swift 6, in the template's code; an app on Swift 6 uses @main.
  source = STUBS + appDelegate.replace(/^import (Expo|React|ReactAppDependencyProvider)\n/gm, '').replace('@UIApplicationMain', '@main');
  dir = root;
});

for (const [mode, flags] of Object.entries(MODES)) {
  test(`the generated AppDelegate.swift type-checks with no diagnostics: ${mode}`, { skip }, () => {
    const file = path.join(dir, `AppDelegate-${mode.replace(/\W+/g, '-')}.swift`);
    fs.writeFileSync(file, source);
    const result = spawnSync(
      'xcrun',
      ['--sdk', 'iphonesimulator', 'swiftc', '-typecheck', '-parse-as-library', '-target', 'arm64-apple-ios15.1-simulator', ...flags, file],
      { encoding: 'utf8' }
    );
    const diagnostics = `${result.stdout}${result.stderr}`.split('\n').filter((line) => /: (error|warning):/.test(line));
    assert.deepEqual(diagnostics, []);
    assert.equal(result.status, 0, result.stderr);
  });
}
