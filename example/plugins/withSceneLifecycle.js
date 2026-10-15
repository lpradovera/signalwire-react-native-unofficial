const { withAppDelegate, withInfoPlist } = require('@expo/config-plugins');

const MARK = '// withSceneLifecycle: SceneDelegate';
const LAUNCH_MARK = '// withSceneLifecycle: watch for the first screen';

/**
 * Adopts the UIScene lifecycle, which iOS 27 requires at launch.
 *
 * An app built with the iOS 27 SDK that has not adopted scenes is ended at
 * launch: SIGTRAP in `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`,
 * before any JavaScript runs. Expo SDK 54's AppDelegate still creates its window
 * the pre-scene way, so this adds a scene manifest to Info.plist and a
 * SceneDelegate that moves the AppDelegate's window onto the scene.
 *
 * Under scenes iOS delivers URLs and user activities to the scene rather than
 * the app delegate, so the SceneDelegate hands them back to the AppDelegate's
 * own handlers (Expo's, then React Native's Linking): a link opened while the
 * app runs, and the one a scene connects with, once the first screen is up and
 * JavaScript is listening. React Native posts RCTContentDidAppearNotification
 * once per root view, which can be before the first scene connects (a VoIP
 * push launches the app in the background, and the user opens it later) or
 * long before a scene reconnects, so the AppDelegate starts watching for it at
 * launch and a scene that connects afterwards forwards its URL at once.
 *
 * Remove once Expo's template adopts scenes itself.
 */
const SCENE_DELEGATE = `
${MARK}
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  /** Whether React Native has put its first screen up, so JavaScript listens for links. */
  private static var contentAppeared = false
  private static var waiting: [() -> Void] = []
  private static var contentObserver: NSObjectProtocol?

  /** Called first thing at launch: the notification can come before any scene exists. */
  static func watchForContent() {
    contentObserver = NotificationCenter.default.addObserver(
      forName: NSNotification.Name("RCTContentDidAppearNotification"), object: nil, queue: .main
    ) { _ in
      if let observer = contentObserver {
        NotificationCenter.default.removeObserver(observer)
        contentObserver = nil
      }
      contentAppeared = true
      let pending = waiting
      waiting = []
      pending.forEach { $0() }
    }
  }

  /** Runs the work once JavaScript listens: now, or when the first screen appears. */
  private static func whenContentAppears(_ work: @escaping () -> Void) {
    if contentAppeared {
      DispatchQueue.main.async(execute: work)
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
    appWindow.makeKeyAndVisible()

    // Under scenes the launch options carry no URL: the scene does. Pass it on
    // once JavaScript listens, which on a cold start is after this.
    let urls = connectionOptions.urlContexts.map { $0.url }
    let activities = Array(connectionOptions.userActivities)
    if urls.isEmpty && activities.isEmpty { return }
    SceneDelegate.whenContentAppears {
      urls.forEach(SceneDelegate.open)
      activities.forEach(SceneDelegate.continueActivity)
    }
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    URLContexts.forEach { SceneDelegate.open($0.url) }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    SceneDelegate.continueActivity(userActivity)
  }

  private static func open(_ url: URL) {
    let app = UIApplication.shared
    _ = app.delegate?.application?(app, open: url, options: [:])
  }

  private static func continueActivity(_ activity: NSUserActivity) {
    let app = UIApplication.shared
    _ = app.delegate?.application?(app, continue: activity, restorationHandler: { _ in })
  }
}
`;

module.exports = function withSceneLifecycle(config) {
  config = withInfoPlist(config, (plistConfig) => {
    plistConfig.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate'
          }
        ]
      }
    };
    return plistConfig;
  });
  return withAppDelegate(config, (delegateConfig) => {
    if (delegateConfig.modResults.language !== 'swift') {
      throw new Error('withSceneLifecycle: expected a Swift AppDelegate');
    }
    let contents = delegateConfig.modResults.contents;
    if (!contents.includes(LAUNCH_MARK)) {
      const launch = /didFinishLaunchingWithOptions launchOptions:[^{]*\{\n/;
      if (!launch.test(contents)) {
        throw new Error('withSceneLifecycle: no application(_:didFinishLaunchingWithOptions:) in the AppDelegate');
      }
      contents = contents.replace(launch, (head) => `${head}    ${LAUNCH_MARK}\n    SceneDelegate.watchForContent()\n`);
    }
    // The SceneDelegate is the last thing in the file: rewritten on every
    // prebuild, so a change here reaches an existing ios/ without --clean.
    const existing = contents.indexOf(`\n${MARK}`);
    contents = (existing === -1 ? contents : contents.slice(0, existing)) + SCENE_DELEGATE;
    delegateConfig.modResults.contents = contents;
    return delegateConfig;
  });
};
