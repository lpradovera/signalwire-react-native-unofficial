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
 * App Transport Security blocks plain HTTP by default. Expo's
 * `NSAllowsLocalNetworking` covers `.local` and the RFC1918 ranges, but a
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
  NSExceptionDomains: {
    'ts.net': {
      NSIncludesSubdomains: true,
      NSExceptionAllowsInsecureHTTPLoads: true
    }
  }
};

module.exports = ({ config }) => {
  const appId = process.env.SW_APP_ID || PLACEHOLDER_APP_ID;

  return {
    ...config,
    ios: {
      ...config.ios,
      bundleIdentifier: appId,
      infoPlist: {
        ...config.ios?.infoPlist,
        NSAppTransportSecurity: {
          ...config.ios?.infoPlist?.NSAppTransportSecurity,
          ...TAILNET_ATS_EXCEPTION
        }
      }
    },
    android: { ...config.android, package: appId }
  };
};
