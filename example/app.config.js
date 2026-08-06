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

module.exports = ({ config }) => {
  const appId = process.env.SW_APP_ID || PLACEHOLDER_APP_ID;

  return {
    ...config,
    ios: { ...config.ios, bundleIdentifier: appId },
    android: { ...config.android, package: appId }
  };
};
