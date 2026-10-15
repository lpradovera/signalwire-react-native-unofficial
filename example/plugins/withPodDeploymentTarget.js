const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');

const MARK = '# withPodDeploymentTarget';

/**
 * Raises every pod target to the app's own iOS minimum, in the Podfile's
 * post_install.
 *
 * Xcode 27 refuses a target whose deployment target is below the oldest it
 * supports (15.0), and some pods still declare far older ones: the build failed
 * at `RNCAsyncStorage-RNCAsyncStorage_resources`, "IPHONEOS_DEPLOYMENT_TARGET
 * is set to 9.0, but the range of supported deployment target versions is 15.0
 * to 27.0". Targets that already ask for more are left alone.
 *
 * Runs after react_native_post_install, which sets per-pod build settings of
 * its own. A Podfile edit rather than a config option because Expo exposes
 * only the app's deployment target, not the pods'.
 */
module.exports = function withPodDeploymentTarget(config, minimum = '15.1') {
  return withDangerousMod(config, [
    'ios',
    (modConfig) => {
      const file = path.join(modConfig.modRequest.platformProjectRoot, 'Podfile');
      let podfile = fs.readFileSync(file, 'utf8');
      if (!podfile.includes(MARK)) {
        const postInstall = /react_native_post_install\([\s\S]*?\n\s*\)\n/;
        if (!postInstall.test(podfile)) {
          throw new Error('withPodDeploymentTarget: no react_native_post_install call in the Podfile');
        }
        podfile = podfile.replace(
          postInstall,
          (call) => `${call}    ${MARK}
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build|
        if build.build_settings['IPHONEOS_DEPLOYMENT_TARGET'].to_f < ${minimum}
          build.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${minimum}'
        end
      end
    end
`
        );
        fs.writeFileSync(file, podfile);
      }
      return modConfig;
    }
  ]);
};
