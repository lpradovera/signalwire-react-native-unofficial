const { withPodfile, withPodfileProperties } = require('@expo/config-plugins');
const { mergeContents, withLf } = require('./generatedCode');

const TAG = 'withReactNativeFromSource';
const POST_INSTALL = /^[ \t]*post_install do \|(\w+)\|[ \t]*$/m;

/**
 * Builds React Native for iOS from source, so that the root `patches/`
 * react-native patch (applied to node_modules by the postinstall) reaches the
 * app. The prebuilt React Native that Expo uses by default (React.xcframework)
 * ignores node_modules sources.
 *
 * The patch fixes react/react-native#58904: on the New Architecture, the keys
 * typed right after the first character of an empty TextInput can be lost
 * (docs/patches/README.md). Delete this plugin, and the patch, once the app is
 * on a React Native release that fixes it.
 *
 * Two edits:
 * - Podfile.properties.json: `ios.buildReactNativeFromSource` = "true", which
 *   the Expo Podfile reads to leave RCT_USE_PREBUILT_RNCORE and RCT_USE_RN_DEP
 *   unset (what expo-build-properties' ios.buildReactNativeFromSource writes).
 * - The Podfile's post_install: the `fmt` pod is compiled as C++17. fmt 11.0.2
 *   (React Native 0.81) does not compile as C++20 with the clang in Xcode 26.4
 *   and later: "call to consteval function
 *   'fmt::basic_format_string<...>::basic_format_string<FMT_COMPILE_STRING, 0>'
 *   is not a constant expression" in format-inl.h. Built as C++17 it takes its
 *   constexpr path instead. The target's own build setting overrides the C++20
 *   the pod's xcconfig asks for; nothing else in post_install sets it for pods.
 */
function block(installer) {
  return `    ${installer}.pods_project.targets.each do |target|
      next unless target.name == 'fmt'
      target.build_configurations.each do |build|
        build.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++17'
      end
    end`;
}

function addFmtBlock(podfile) {
  return withLf(podfile, (contents) => {
    const postInstall = POST_INSTALL.exec(contents);
    if (!postInstall) {
      throw new Error('withReactNativeFromSource: no `post_install do |installer|` block in the Podfile');
    }
    return mergeContents({
      src: contents,
      newSrc: block(postInstall[1]),
      tag: TAG,
      anchor: POST_INSTALL,
      offset: 1,
      comment: '    #'
    }).contents;
  });
}

module.exports = function withReactNativeFromSource(config) {
  config = withPodfileProperties(config, (propertiesConfig) => {
    propertiesConfig.modResults['ios.buildReactNativeFromSource'] = 'true';
    return propertiesConfig;
  });
  return withPodfile(config, (podfileConfig) => {
    podfileConfig.modResults.contents = addFmtBlock(podfileConfig.modResults.contents);
    return podfileConfig;
  });
};

module.exports.addFmtBlock = addFmtBlock;
