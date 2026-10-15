const { withAppDelegate, withInfoPlist } = require('@expo/config-plugins');

const MARK = '// withSceneLifecycle: SceneDelegate';

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
 * app runs, and on a cold start the one it was launched with, once the first
 * screen is up and JavaScript is listening.
 *
 * Remove once Expo's template adopts scenes itself.
 */
const SCENE_DELEGATE = `
${MARK}
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

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

    // A cold start: the launch options carry no URL under scenes, and nothing
    // listens yet, so pass the launch URL or activity on once the first screen is up.
    let urls = connectionOptions.urlContexts.map { $0.url }
    let activities = Array(connectionOptions.userActivities)
    if urls.isEmpty && activities.isEmpty { return }
    var token: NSObjectProtocol?
    token = NotificationCenter.default.addObserver(
      forName: NSNotification.Name("RCTContentDidAppearNotification"), object: nil, queue: .main
    ) { _ in
      if let token = token { NotificationCenter.default.removeObserver(token) }
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
    if (!delegateConfig.modResults.contents.includes(MARK)) {
      delegateConfig.modResults.contents += SCENE_DELEGATE;
    }
    return delegateConfig;
  });
};
