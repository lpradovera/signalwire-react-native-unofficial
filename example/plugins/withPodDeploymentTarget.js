const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');

const BEGIN = '# withPodDeploymentTarget: begin';
const END = '# withPodDeploymentTarget: end';

/**
 * Raises pod resource-bundle targets to the app's own iOS deployment target,
 * in the Podfile's post_install.
 *
 * Xcode 27 refuses a target whose deployment target is below the oldest it
 * supports (15.0), and some pods' resource bundles still declare far older
 * ones: the build failed at `RNCAsyncStorage-RNCAsyncStorage_resources`,
 * "IPHONEOS_DEPLOYMENT_TARGET is set to 9.0, but the range of supported
 * deployment target versions is 15.0 to 27.0". React Native's own
 * react_native_post_install already raises every pod's native target
 * (ReactNativePodsUtils.updateOSDeploymentTarget) but not their resource
 * bundles, so only those are touched here. Bundles that already ask for more
 * are left alone.
 *
 * The minimum is read when `pod install` runs, from the same place the
 * Podfile's `platform :ios` line reads it (Podfile.properties.json, which Expo
 * writes from expo-build-properties' ios.deploymentTarget), so it can't go
 * stale. The block sits between markers and is rewritten on every prebuild.
 *
 * A Podfile edit rather than a config option because Expo exposes only the
 * app's deployment target, not the pods'.
 */
const BLOCK = `    ${BEGIN}
    app_minimum = (podfile_properties['ios.deploymentTarget'] || '15.1').to_s
    installer.target_installation_results.pod_target_installation_results.each_value do |result|
      result.resource_bundle_targets.each do |bundle|
        bundle.build_configurations.each do |build|
          if build.build_settings['IPHONEOS_DEPLOYMENT_TARGET'].to_f < app_minimum.to_f
            build.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = app_minimum
          end
        end
      end
    end
    ${END}
`;

module.exports = function withPodDeploymentTarget(config) {
  return withDangerousMod(config, [
    'ios',
    (modConfig) => {
      const file = path.join(modConfig.modRequest.platformProjectRoot, 'Podfile');
      let podfile = fs.readFileSync(file, 'utf8');
      const existing = new RegExp(`[ \\t]*${BEGIN}[\\s\\S]*?${END}\\n`);
      if (existing.test(podfile)) {
        podfile = podfile.replace(existing, BLOCK);
      } else {
        const postInstall = /react_native_post_install\([\s\S]*?\n\s*\)\n/;
        if (!postInstall.test(podfile)) {
          throw new Error('withPodDeploymentTarget: no react_native_post_install call in the Podfile');
        }
        podfile = podfile.replace(postInstall, (call) => `${call}${BLOCK}`);
      }
      fs.writeFileSync(file, podfile);
      return modConfig;
    }
  ]);
};
