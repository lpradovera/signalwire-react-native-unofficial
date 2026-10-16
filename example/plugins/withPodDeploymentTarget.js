const { withPodfile } = require('@expo/config-plugins');
const { mergeContents, withLf } = require('./generatedCode');

const TAG = 'withPodDeploymentTarget';
// The block this plugin wrote before it used Expo's tagged blocks.
const PREVIOUS_BLOCK = /^[ \t]*# withPodDeploymentTarget: begin\n[\s\S]*?^[ \t]*# withPodDeploymentTarget: end\n/m;
const POST_INSTALL = /^[ \t]*post_install do \|(\w+)\|[ \t]*$/m;

/**
 * Raises pod resource-bundle targets to the app's own iOS deployment target,
 * in the Podfile's post_install.
 *
 * Xcode 27 refuses a target whose deployment target is below the oldest it
 * supports (15.0), and some pods' resource bundles still declare far older
 * ones: the build failed at `RNCAsyncStorage-RNCAsyncStorage_resources`,
 * "IPHONEOS_DEPLOYMENT_TARGET is set to 9.0, but the range of supported
 * deployment target versions is 15.0 to 27.0". React Native's own
 * react_native_post_install raises every pod's native target
 * (ReactNativePodsUtils.updateOSDeploymentTarget) but not their resource
 * bundles, so only those are touched here, and the block can run before it.
 * Bundles that already ask for more are left alone.
 *
 * React Native fixed this upstream in facebook/react-native#58687 (commit
 * d45fc2d289, on main since 2026-09-28; not in 0.88.0): updateOSDeploymentTarget
 * now raises resource_bundle_targets too. Delete this plugin once the app is on
 * a React Native release that contains that commit.
 *
 * The minimum is read when `pod install` runs, from the same place the
 * Podfile's `platform :ios` line reads it (Podfile.properties.json, which Expo
 * writes from expo-build-properties' ios.deploymentTarget), so it can't go
 * stale. The block is one of Expo's tagged blocks, right after the
 * `post_install do |installer|` line, and is rewritten when it changes.
 *
 * A Podfile edit rather than a config option because Expo exposes only the
 * app's deployment target, not the pods'.
 */
function block(installer) {
  return `    app_minimum = (podfile_properties['ios.deploymentTarget'] || '15.1').to_s
    ${installer}.target_installation_results.pod_target_installation_results.each_value do |result|
      result.resource_bundle_targets.each do |bundle|
        bundle.build_configurations.each do |build|
          if build.build_settings['IPHONEOS_DEPLOYMENT_TARGET'].to_f < app_minimum.to_f
            build.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = app_minimum
          end
        end
      end
    end`;
}

function addDeploymentTargetBlock(podfile) {
  return withLf(podfile, (contents) => {
    contents = contents.replace(PREVIOUS_BLOCK, '');
    const postInstall = POST_INSTALL.exec(contents);
    if (!postInstall) {
      throw new Error('withPodDeploymentTarget: no `post_install do |installer|` block in the Podfile');
    }
    return mergeContents({
      src: contents,
      newSrc: block(postInstall[1]),
      tag: TAG,
      anchor: POST_INSTALL,
      offset: 1,
      // Indents the begin/end comments with the block.
      comment: '    #'
    }).contents;
  });
}

module.exports = function withPodDeploymentTarget(config) {
  return withPodfile(config, (podfileConfig) => {
    podfileConfig.modResults.contents = addDeploymentTargetBlock(podfileConfig.modResults.contents);
    return podfileConfig;
  });
};
