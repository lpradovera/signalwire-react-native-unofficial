/**
 * Applies @react-native-firebase/app's config plugin to Android only.
 *
 * iOS takes call pushes through PushKit and uses no Firebase. The Firebase
 * plugin configures both platforms whenever it is applied, and its iOS half
 * fails prebuild without a GoogleService-Info.plist ("Path to
 * GoogleService-Info.plist is not defined"); supplying one would configure
 * Firebase in the iOS AppDelegate for an app that has no use for it. And
 * GOOGLE_SERVICES_JSON, which switches Firebase on, is set for the whole
 * environment, so an iOS prebuild run where Android push is configured would
 * apply the iOS half too.
 *
 * So this applies exactly the plugin's three Android mods, in the plugin's own
 * order: the google-services Gradle dependency, the plugin application, and
 * the copy of android.googleServicesFile into android/app.
 */
const {
  withApplyGoogleServicesPlugin,
  withBuildscriptDependency,
  withCopyAndroidGoogleServices
} = require('@react-native-firebase/app/plugin/build/android');
const { withPlugins } = require('@expo/config-plugins');

module.exports = function withFirebaseAndroid(config) {
  return withPlugins(config, [
    withBuildscriptDependency,
    withApplyGoogleServicesPlugin,
    withCopyAndroidGoogleServices
  ]);
};
