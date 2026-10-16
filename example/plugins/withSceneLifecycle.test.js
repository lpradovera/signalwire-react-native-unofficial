const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, test } = require('node:test');
const { withInfoPlist } = require('@expo/config-plugins');

const withSceneLifecycle = require('./withSceneLifecycle');
const { appDelegatePlugin, count, makeProject, prebuild, removeProjects } = require('./test/prebuild');

after(removeProjects);

const START_BEGIN = '// @generated begin withSceneLifecycle-start -';
const DELEGATE_BEGIN = '// @generated begin withSceneLifecycle-delegate -';
const SCENE_DELEGATE = '$(PRODUCT_MODULE_NAME).SceneDelegate';

const CARPLAY = [
  { UISceneConfigurationName: 'CarPlay', UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).CarSceneDelegate' }
];

/** A plugin that adds a CarPlay scene and merges with whatever manifest is there. */
const withCarPlayScene = (config) =>
  withInfoPlist(config, (plistConfig) => {
    const manifest = plistConfig.modResults.UIApplicationSceneManifest ?? {};
    manifest.UISceneConfigurations = {
      ...manifest.UISceneConfigurations,
      CPTemplateApplicationSceneSessionRoleApplication: CARPLAY
    };
    plistConfig.modResults.UIApplicationSceneManifest = manifest;
    return plistConfig;
  });

function appScenes(infoPlist) {
  return infoPlist.UIApplicationSceneManifest.UISceneConfigurations.UIWindowSceneSessionRoleApplication;
}

test('adds the scene manifest to a template Info.plist', async () => {
  const { infoPlist } = await prebuild(makeProject('plist'), [withSceneLifecycle]);
  assert.deepEqual(infoPlist.UIApplicationSceneManifest, {
    UIApplicationSupportsMultipleScenes: false,
    UISceneConfigurations: {
      UIWindowSceneSessionRoleApplication: [
        { UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: SCENE_DELEGATE }
      ]
    }
  });
});

test("keeps a manifest from the app config: its other scenes and UIApplicationSupportsMultipleScenes", async () => {
  const root = makeProject('plist-config');
  const ios = {
    infoPlist: {
      UIApplicationSceneManifest: {
        UIApplicationSupportsMultipleScenes: true,
        UISceneConfigurations: { CPTemplateApplicationSceneSessionRoleApplication: CARPLAY }
      }
    }
  };
  const { infoPlist } = await prebuild(root, [withSceneLifecycle], { ios });
  const manifest = infoPlist.UIApplicationSceneManifest;
  assert.equal(manifest.UIApplicationSupportsMultipleScenes, true);
  assert.deepEqual(manifest.UISceneConfigurations.CPTemplateApplicationSceneSessionRoleApplication, CARPLAY);
  assert.equal(appScenes(infoPlist)[0].UISceneDelegateClassName, SCENE_DELEGATE);
});

test('keeps the scenes of a plugin listed after it (whose mod runs first)', async () => {
  const { infoPlist } = await prebuild(makeProject('plist-after'), [withSceneLifecycle, withCarPlayScene]);
  assert.deepEqual(infoPlist.UIApplicationSceneManifest.UISceneConfigurations.CPTemplateApplicationSceneSessionRoleApplication, CARPLAY);
  assert.equal(appScenes(infoPlist).length, 1);
});

test('a second prebuild leaves the manifest as it was', async () => {
  const root = makeProject('plist-twice');
  const one = await prebuild(root, [withSceneLifecycle]);
  const two = await prebuild(root, [withSceneLifecycle]);
  assert.deepEqual(two.infoPlist.UIApplicationSceneManifest, one.infoPlist.UIApplicationSceneManifest);
});

test('refuses an Info.plist whose application scene already has another delegate', async () => {
  const ios = {
    infoPlist: {
      UIApplicationSceneManifest: {
        UISceneConfigurations: {
          UIWindowSceneSessionRoleApplication: [{ UISceneDelegateClassName: 'OtherSceneDelegate' }]
        }
      }
    }
  };
  await assert.rejects(prebuild(makeProject('plist-conflict'), [withSceneLifecycle], { ios }), /OtherSceneDelegate/);
});

test("hands the template's React Native start to the SceneDelegate, with the template's call kept", async () => {
  const { appDelegate } = await prebuild(makeProject('start'), [withSceneLifecycle]);
  assert.equal(count(appDelegate, START_BEGIN), 1);
  const start = appDelegate.slice(appDelegate.indexOf(START_BEGIN));
  assert.match(
    start,
    /^\/\/ @generated begin withSceneLifecycle-start - .*\n {4}SceneDelegate\.startReactNative\(launchOptions: launchOptions\) \{ \[self\] launchOptions in\n {6}factory\.startReactNative\(\n {8}withModuleName: "main",\n {8}in: window,\n {8}launchOptions: launchOptions\)\n {4}\}\n {4}\/\/ @generated end withSceneLifecycle-start\n/
  );
  // Still inside didFinishLaunching, after the window and before super.
  const launch = appDelegate.indexOf('didFinishLaunchingWithOptions');
  assert.ok(launch < appDelegate.indexOf('window = UIWindow(frame: UIScreen.main.bounds)'));
  assert.ok(appDelegate.indexOf(START_BEGIN) < appDelegate.indexOf('return super.application(application, didFinishLaunchingWithOptions'));
  assert.equal(count(appDelegate, 'factory.startReactNative('), 1);
});

test('adds one SceneDelegate, before the AppDelegate, and a second prebuild changes nothing', async () => {
  const root = makeProject('twice');
  const one = await prebuild(root, [withSceneLifecycle]);
  const two = await prebuild(root, [withSceneLifecycle]);
  assert.equal(two.appDelegate, one.appDelegate);
  assert.equal(count(one.appDelegate, DELEGATE_BEGIN), 1);
  assert.equal(count(one.appDelegate, 'class SceneDelegate:'), 1);
  assert.ok(one.appDelegate.indexOf('class SceneDelegate:') < one.appDelegate.indexOf('@UIApplicationMain'));
});

test("another plugin's code after the SceneDelegate survives a second prebuild", async () => {
  // Listed before withSceneLifecycle, so its mod runs after it and appends after the SceneDelegate;
  // it decides whether it has run by an import it adds at the top.
  const other = appDelegatePlugin((contents) =>
    contents.includes('import FooKit')
      ? contents
      : contents.replace('import Expo\n', 'import Expo\nimport FooKit\n') + '\nextension AppDelegate {\n  func fooKitHello() {}\n}\n'
  );
  const root = makeProject('tail');
  const one = await prebuild(root, [other, withSceneLifecycle]);
  const two = await prebuild(root, [other, withSceneLifecycle]);
  assert.ok(one.appDelegate.includes('func fooKitHello'));
  assert.ok(two.appDelegate.includes('func fooKitHello'));
  assert.equal(two.appDelegate, one.appDelegate);
});

test('changed generated code reaches an existing ios/ without --clean', async () => {
  const root = makeProject('changed');
  const one = await prebuild(root, [withSceneLifecycle]);
  const file = path.join(root, 'ios', 'HelloWorld', 'AppDelegate.swift');
  // What an older version of the plugin might have left: other bodies and hashes under the same tags.
  fs.writeFileSync(
    file,
    one.appDelegate
      .replace(/(@generated begin withSceneLifecycle-(?:start|delegate) - .*) sync-[0-9a-f]+/g, '$1 sync-0000')
      .replace('SceneDelegate.startReactNative(launchOptions: launchOptions) {', 'SceneDelegate.oldStart(launchOptions: launchOptions) {')
      .replace('class SceneDelegate: UIResponder, UIWindowSceneDelegate {', 'class SceneDelegate: UIResponder, UIWindowSceneDelegate {\n  static func oldStart() {}')
  );
  const two = await prebuild(root, [withSceneLifecycle]);
  assert.equal(two.appDelegate, one.appDelegate);
});

test("replaces the previous version's launch line and SceneDelegate", async () => {
  const legacy = fs.readFileSync(path.join(__dirname, '__fixtures__', 'legacy-12abf23', 'AppDelegate.swift'), 'utf8');
  const fresh = await prebuild(makeProject('fresh'), [withSceneLifecycle]);
  const { appDelegate } = await prebuild(makeProject('legacy', { 'HelloWorld/AppDelegate.swift': () => legacy }), [
    withSceneLifecycle
  ]);
  assert.ok(!appDelegate.includes('watchForContent()\n    window ='));
  assert.ok(!appDelegate.includes('// withSceneLifecycle: SceneDelegate'));
  assert.equal(count(appDelegate, 'class SceneDelegate:'), 1);
  assert.equal(appDelegate, fresh.appDelegate);
});

test('fails with a message when the AppDelegate has no React Native start to hand over', async () => {
  const root = makeProject('no-start', {
    'HelloWorld/AppDelegate.swift': (contents) => contents.replace(/factory\.startReactNative\([\s\S]*?\)\n/, '')
  });
  await assert.rejects(prebuild(root, [withSceneLifecycle]), /withSceneLifecycle: no `factory\.startReactNative\(\.\.\.\)` call/);
});
