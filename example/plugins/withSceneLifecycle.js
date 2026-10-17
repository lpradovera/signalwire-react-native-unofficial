const { withAppDelegate, withInfoPlist } = require('@expo/config-plugins');
const { createGeneratedHeaderComment, mergeContents } = require('./generatedCode');

const START_TAG = 'withSceneLifecycle-start';
const DELEGATE_TAG = 'withSceneLifecycle-delegate';
const SCENE_ROLE = 'UIWindowSceneSessionRoleApplication';
const SCENE_DELEGATE_CLASS = '$(PRODUCT_MODULE_NAME).SceneDelegate';

/**
 * Adopts the UIScene lifecycle, which iOS 27 requires at launch.
 *
 * An app built with the iOS 27 SDK that has not adopted scenes is ended at
 * launch: SIGTRAP in `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`,
 * before any JavaScript runs. Expo SDK 54's AppDelegate still creates its window
 * the pre-scene way, so this adds a scene manifest to Info.plist and a
 * SceneDelegate that moves the AppDelegate's window onto the scene.
 *
 * Under scenes the launch options carry no URL or user activity: the scene's
 * connection options do, and they arrive after didFinishLaunching. React
 * Native's Linking.getInitialURL() reads only the launch options, so the
 * template's start of React Native is handed to the SceneDelegate, which
 * starts it when the scene connects, with the scene's URL and browsing
 * activity put back into the launch options, as Expo SDK 58's
 * ExpoAppSceneDelegate does. A launch with no scene (a VoIP push wakes the app
 * in the background) still starts React Native, on the next turn of the main
 * queue. In Debug builds with expo-dev-client, expo-dev-launcher needs the
 * start inside didFinishLaunching, so it stays there and the launcher takes
 * the URL as its pending deep link instead.
 *
 * The SceneDelegate also hands the scene's events back to the AppDelegate's
 * own handlers, so Expo's subscribers and React Native see them as before:
 * URLs (with their options) and user activities, the active/background
 * transitions, and home-screen quick actions. A URL a scene connects with
 * while React Native is already running waits until its first screen is up.
 *
 * The scene manifest is merged into any the app already has (another scene
 * role, such as CarPlay's, is kept). There is one window, the AppDelegate's,
 * so with UIApplicationSupportsMultipleScenes on, each new window scene takes it.
 *
 * Both edits to AppDelegate.swift are Expo tagged blocks
 * (`// @generated begin ...`), rewritten when they change, so a prebuild without
 * --clean picks up a new version and leaves the rest of the file alone.
 *
 * Remove once Expo's template adopts scenes itself (Expo SDK 58 does).
 */
const SCENE_DELEGATE = `class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  typealias LaunchOptions = [UIApplication.LaunchOptionsKey: Any]

  /** expo-dev-launcher, in Debug builds with expo-dev-client. */
  private static let devLauncher = NSClassFromString("EXDevLauncherController") != nil
  /** The AppDelegate's start of React Native, until a scene connects or the launch turns out to have none. */
  private static var pendingStart: (@MainActor (LaunchOptions?) -> Void)?
  private static var launchOptions: LaunchOptions?
  /** Whether React Native has put its first screen up. */
  private static var contentAppeared = false
  private static var waiting: [@MainActor () -> Void] = []
  private static var contentObserver: NSObjectProtocol?

  /** Called by the AppDelegate's didFinishLaunching in place of starting React Native itself. */
  static func startReactNative(launchOptions: LaunchOptions?, start: @escaping @MainActor (LaunchOptions?) -> Void) {
    watchForContent()
    if devLauncher {
      start(launchOptions)
      return
    }
    self.launchOptions = launchOptions
    pendingStart = start
    // A scene connecting at launch does so before this runs; a background launch has none.
    DispatchQueue.main.async { startPending(url: nil, activity: nil) }
  }

  /** Starts React Native if it is still waiting, with what the scene was opened with. */
  @discardableResult
  private static func startPending(url: URL?, activity: NSUserActivity?) -> Bool {
    guard let start = pendingStart else { return false }
    pendingStart = nil
    var options = launchOptions ?? [:]
    launchOptions = nil
    // The keys' raw values: the UIApplication accessors are deprecated in favor of scenes,
    // but these are the keys getInitialURL reads.
    if let url {
      options[UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsURLKey")] = url
    }
    if let activity {
      options[UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsUserActivityDictionaryKey")] = [
        "UIApplicationLaunchOptionsUserActivityTypeKey": activity.activityType,
        "UIApplicationLaunchOptionsUserActivityKey": activity
      ]
    }
    start(options.isEmpty ? nil : options)
    return true
  }

  /** RCTContentDidAppearNotification comes once per root view, and can come before any scene exists. */
  private static func watchForContent() {
    guard contentObserver == nil, !contentAppeared else { return }
    contentObserver = NotificationCenter.default.addObserver(
      forName: NSNotification.Name("RCTContentDidAppearNotification"), object: nil, queue: .main
    ) { _ in
      MainActor.assumeIsolated { contentDidAppear() }
    }
  }

  private static func contentDidAppear() {
    if let observer = contentObserver {
      NotificationCenter.default.removeObserver(observer)
      contentObserver = nil
    }
    contentAppeared = true
    let pending = waiting
    waiting = []
    for work in pending {
      work()
    }
  }

  /** Runs the work once React Native's first screen is up: now, or when it appears. */
  private static func whenContentAppears(_ work: @escaping @MainActor () -> Void) {
    if contentAppeared {
      DispatchQueue.main.async { work() }
    } else {
      waiting.append(work)
    }
  }

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let appWindow = (UIApplication.shared.delegate as? AppDelegate)?.window else { return }
    appWindow.windowScene = windowScene
    appWindow.frame = windowScene.coordinateSpace.bounds
    window = appWindow

    let contexts = connectionOptions.urlContexts
    let activities = connectionOptions.userActivities
    let startedHere = SceneDelegate.startPending(
      url: contexts.first?.url,
      activity: activities.first { $0.activityType == NSUserActivityTypeBrowsingWeb }
    )
    appWindow.makeKeyAndVisible()

    if let shortcutItem = connectionOptions.shortcutItem {
      SceneDelegate.perform(shortcutItem) { _ in }
    }
    if contexts.isEmpty && activities.isEmpty { return }
    let forward: @MainActor () -> Void = {
      for context in contexts {
        SceneDelegate.open(context)
      }
      for activity in activities {
        SceneDelegate.continueActivity(activity)
      }
    }
    // Started with these launch options (or under expo-dev-launcher): as at a pre-scene launch,
    // the app delegate gets them now too. Already running: once JavaScript can listen.
    if startedHere || SceneDelegate.devLauncher {
      forward()
    } else {
      SceneDelegate.whenContentAppears(forward)
    }
  }

  func sceneDidDisconnect(_ scene: UIScene) {
    window = nil
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    let app = UIApplication.shared
    app.delegate?.applicationDidBecomeActive?(app)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    let app = UIApplication.shared
    app.delegate?.applicationWillResignActive?(app)
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    let app = UIApplication.shared
    app.delegate?.applicationWillEnterForeground?(app)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    let app = UIApplication.shared
    app.delegate?.applicationDidEnterBackground?(app)
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    for context in URLContexts {
      SceneDelegate.open(context)
    }
  }

  func scene(_ scene: UIScene, willContinueUserActivityWithType userActivityType: String) {
    let app = UIApplication.shared
    _ = app.delegate?.application?(app, willContinueUserActivityWithType: userActivityType)
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    SceneDelegate.continueActivity(userActivity)
  }

  func scene(_ scene: UIScene, didFailToContinueUserActivityWithType userActivityType: String, error: Error) {
    let app = UIApplication.shared
    app.delegate?.application?(app, didFailToContinueUserActivityWithType: userActivityType, error: error)
  }

  func scene(_ scene: UIScene, didUpdate userActivity: NSUserActivity) {
    let app = UIApplication.shared
    app.delegate?.application?(app, didUpdate: userActivity)
  }

  func windowScene(
    _ windowScene: UIWindowScene,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    SceneDelegate.perform(shortcutItem, completionHandler: completionHandler)
  }

  private static func open(_ context: UIOpenURLContext) {
    let app = UIApplication.shared
    var options: [UIApplication.OpenURLOptionsKey: Any] = [.openInPlace: context.options.openInPlace]
    if let sourceApplication = context.options.sourceApplication {
      options[.sourceApplication] = sourceApplication
    }
    if let annotation = context.options.annotation {
      options[.annotation] = annotation
    }
    _ = app.delegate?.application?(app, open: context.url, options: options)
  }

  private static func continueActivity(_ activity: NSUserActivity) {
    let app = UIApplication.shared
    _ = app.delegate?.application?(app, continue: activity, restorationHandler: { _ in })
  }

  private static func perform(_ shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
    let app = UIApplication.shared
    if app.delegate?.application?(app, performActionFor: shortcutItem, completionHandler: completionHandler) == nil {
      completionHandler(false)
    }
  }
}`;

// The template's `factory.startReactNative(...)` call, to its closing parenthesis at the end of a line.
const START_CALL = /^([ \t]*)factory\.startReactNative\([\s\S]*?\)[ \t]*$/m;
const START_BLOCK = new RegExp(
  `^[ \\t]*// @generated begin ${START_TAG} - .*\\n.*\\n([\\s\\S]*?)\\n[ \\t]*\\}\\n[ \\t]*// @generated end ${START_TAG}[ \\t]*$`,
  'm'
);

/** Puts the template's start call back where the start block is, so it can be wrapped afresh. */
function unwrapStart(contents) {
  return contents.replace(START_BLOCK, (_, call) => call.replace(/^ {2}/gm, ''));
}

/**
 * Wraps the template's start call so the SceneDelegate decides when it runs and
 * with which launch options (the closure's `launchOptions` shadows the
 * method's). The call itself is kept as the template wrote it.
 */
function wrapStart(contents) {
  contents = unwrapStart(contents);
  const match = START_CALL.exec(contents);
  if (!match) {
    throw new Error('withSceneLifecycle: no `factory.startReactNative(...)` call in the AppDelegate to hand to the SceneDelegate');
  }
  const [call, indent] = match;
  const body = [
    `${indent}SceneDelegate.startReactNative(launchOptions: launchOptions) { [self] launchOptions in`,
    call.replace(/^/gm, '  '),
    `${indent}}`
  ].join('\n');
  const block = [
    `${indent}${createGeneratedHeaderComment(body, START_TAG, '//')}`,
    body,
    `${indent}// @generated end ${START_TAG}`
  ].join('\n');
  return contents.slice(0, match.index) + block + contents.slice(match.index + call.length);
}

function addSceneDelegate(contents) {
  contents = wrapStart(contents);
  return mergeContents({
    src: contents,
    newSrc: SCENE_DELEGATE,
    tag: DELEGATE_TAG,
    anchor: /^@(UIApplicationMain|main)\b/,
    offset: 0,
    comment: '//'
  }).contents;
}

/** Adds the SceneDelegate to the app's scene manifest, keeping what is already there. */
function addSceneManifest(infoPlist) {
  const manifest = { ...infoPlist.UIApplicationSceneManifest };
  manifest.UIApplicationSupportsMultipleScenes ??= false;
  const configurations = { ...manifest.UISceneConfigurations };
  const appScenes = [...(configurations[SCENE_ROLE] ?? [])];
  const other = appScenes.find(
    (scene) => scene.UISceneDelegateClassName && scene.UISceneDelegateClassName !== SCENE_DELEGATE_CLASS
  );
  if (other) {
    throw new Error(
      `withSceneLifecycle: Info.plist already gives ${SCENE_ROLE} the scene delegate ${other.UISceneDelegateClassName}; ` +
        'the app has its own scene lifecycle, so leave this plugin out'
    );
  }
  if (!appScenes.some((scene) => scene.UISceneDelegateClassName === SCENE_DELEGATE_CLASS)) {
    appScenes.unshift({ UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: SCENE_DELEGATE_CLASS });
  }
  configurations[SCENE_ROLE] = appScenes;
  manifest.UISceneConfigurations = configurations;
  infoPlist.UIApplicationSceneManifest = manifest;
  return infoPlist;
}

module.exports = function withSceneLifecycle(config) {
  config = withInfoPlist(config, (plistConfig) => {
    plistConfig.modResults = addSceneManifest(plistConfig.modResults);
    return plistConfig;
  });
  return withAppDelegate(config, (delegateConfig) => {
    if (delegateConfig.modResults.language !== 'swift') {
      throw new Error('withSceneLifecycle: expected a Swift AppDelegate');
    }
    delegateConfig.modResults.contents = addSceneDelegate(delegateConfig.modResults.contents);
    return delegateConfig;
  });
};
