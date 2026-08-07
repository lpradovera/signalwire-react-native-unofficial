const { withAndroidManifest } = require('@expo/config-plugins');

/**
 * Lets this example talk to the support server over plain HTTP.
 *
 * Expo sets `usesCleartextTraffic` for debug builds and not for release, so a
 * release build silently cannot reach an http:// endpoint — the app runs,
 * registers nothing, and reports nothing. It is the Android twin of the ATS
 * exception in app.config.js, and it exists for the same reason: the device
 * reaches this Mac over a tailnet address that has no certificate.
 *
 * Development convenience for this example. A shipping app should use HTTPS.
 */
module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, (androidConfig) => {
    const application = androidConfig.modResults.manifest.application?.[0];
    if (application) {
      application.$['android:usesCleartextTraffic'] = 'true';
    }
    return androidConfig;
  });
};
