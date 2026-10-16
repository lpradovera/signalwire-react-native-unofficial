/**
 * Injects the application identifier from the environment.
 *
 * Bundle identifiers must be globally unique across Apple's ecosystem, so the
 * value that actually gets built is whatever your team owns — which is not
 * something to hard-code into a public repository. Set `SW_APP_ID` (a `.env`
 * file in this directory works, and is gitignored) and both platforms pick it
 * up. Without it, the placeholder below is used, which is fine for
 * `expo export` and the unit tests but will not sign against a real team.
 *
 * The value is read at config-evaluation time, so it must be set for
 * `expo prebuild` and `expo run:ios`, not just at runtime. See TESTING.md.
 */
const PLACEHOLDER_APP_ID = 'com.example.swrnexample';

/**
 * Lets the dev build talk to a Mac reached over Tailscale, in the clear.
 *
 * App Transport Security blocks plain HTTP by default. The template's
 * `NSAllowsLocalNetworking` (kept below) covers `.local` and the RFC1918 ranges, but a
 * tailnet address is CGNAT (100.64/10), so it is not covered — and when the
 * device and the Mac are not on the same LAN, that is the only route there.
 *
 * The obvious workaround, HTTPS via `tailscale serve`, is what this replaces:
 * the iPad failed every handshake with `errSSLRecordOverflow` while the same
 * URL served a clean 200 to curl on the Mac, which cost hours and taught us
 * nothing. Plain HTTP over the tailnet removes TLS from the loop entirely.
 *
 * Scoped to `ts.net` rather than `NSAllowsArbitraryLoads`, so only tailnet
 * hosts are affected. This is a development convenience for the example app:
 * do not copy it into a shipping app.
 */
const TAILNET_ATS_EXCEPTION = {
  'ts.net': {
    NSIncludesSubdomains: true,
    NSExceptionAllowsInsecureHTTPLoads: true
  }
};

/**
 * The template Info.plist's own App Transport Security settings.
 *
 * Expo lays `ios.infoPlist` over the template's Info.plist one level deep, so
 * an `NSAppTransportSecurity` given here replaces the template's dict rather
 * than adding to it, and `config.ios.infoPlist` does not hold the template's
 * values to spread. Without these the exception above was the whole dict: no
 * `NSAllowsLocalNetworking`, so iOS 17+ refused plain HTTP to a LAN IP (the
 * token server, Metro). `npm run verify:prebuild` checks the generated file.
 */
const TEMPLATE_ATS = {
  NSAllowsArbitraryLoads: false,
  NSAllowsLocalNetworking: true
};

module.exports = ({ config }) => {
  const appId = process.env.SW_APP_ID || PLACEHOLDER_APP_ID;

  // Firebase is Android-only here: iOS uses PushKit, not FCM. Adding the
  // plugin unconditionally makes an iOS prebuild demand a
  // GoogleService-Info.plist that this app has no use for, so an iOS-only
  // consumer cannot prebuild at all. Applied only when Android push is
  // actually configured.
  const plugins = process.env.GOOGLE_SERVICES_JSON
    ? ['@react-native-firebase/app', ...(config.plugins ?? [])]
    : (config.plugins ?? []);

  return {
    ...config,
    plugins,
    ios: {
      ...config.ios,
      bundleIdentifier: appId,
      infoPlist: {
        ...config.ios?.infoPlist,
        NSAppTransportSecurity: {
          ...TEMPLATE_ATS,
          ...config.ios?.infoPlist?.NSAppTransportSecurity,
          NSExceptionDomains: {
            ...config.ios?.infoPlist?.NSAppTransportSecurity?.NSExceptionDomains,
            ...TAILNET_ATS_EXCEPTION
          }
        }
      }
    },
    android: {
      ...config.android,
      package: appId,
      // Firebase needs this file to build, and it is per-project, so it is
      // read from the environment for the same reason SW_APP_ID is: it is not
      // something to hard-code into a public repository. Point
      // GOOGLE_SERVICES_JSON at the file Firebase gave you (a path relative to
      // this directory works). Without it the Android build fails at the
      // google-services plugin, not at runtime.
      ...(process.env.GOOGLE_SERVICES_JSON
        ? { googleServicesFile: process.env.GOOGLE_SERVICES_JSON }
        : {})
    }
  };
};
