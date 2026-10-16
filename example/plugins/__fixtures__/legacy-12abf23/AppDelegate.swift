import Expo
import React
import ReactAppDependencyProvider

@UIApplicationMain
public class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // withSceneLifecycle: watch for the first screen
    SceneDelegate.watchForContent()
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory
    bindReactNativeFactory(factory)

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }

  // Universal Links
  public override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
    return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  // Extension point for config-plugins

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}

// withSceneLifecycle: SceneDelegate
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
