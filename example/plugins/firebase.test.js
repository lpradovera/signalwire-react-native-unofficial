/**
 * How the example applies Firebase, checked against the real config plugins.
 *
 * iOS uses PushKit and no Firebase. Firebase's own Expo plugin configures both
 * platforms whenever it is applied, and its iOS half throws during prebuild
 * without a GoogleService-Info.plist. GOOGLE_SERVICES_JSON is set for the
 * whole environment, not per platform, so whatever it adds must add nothing
 * to iOS.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const { withPlugins } = require('@expo/config-plugins');

const exampleRoot = path.join(__dirname, '..');
const appConfig = require('../app.config.js');

function withEnv(value, run) {
  const previous = process.env.GOOGLE_SERVICES_JSON;
  if (value === undefined) {
    delete process.env.GOOGLE_SERVICES_JSON;
  } else {
    process.env.GOOGLE_SERVICES_JSON = value;
  }
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.GOOGLE_SERVICES_JSON;
    } else {
      process.env.GOOGLE_SERVICES_JSON = previous;
    }
  }
}

/** Applies what app.config.js adds to an otherwise empty config. */
function applyExampleConfig() {
  const base = { name: 'probe', slug: 'probe', plugins: [], _internal: { projectRoot: exampleRoot } };
  const evaluated = appConfig({ config: base });
  return withPlugins({ ...evaluated, plugins: undefined }, evaluated.plugins);
}

test('with GOOGLE_SERVICES_JSON set, Firebase adds Android mods and no iOS mods', () => {
  const config = withEnv('./google-services.json', applyExampleConfig);

  assert.deepEqual(Object.keys(config.mods?.ios ?? {}), []);
  // The google-services Gradle plugin and the copied file: without these the
  // Android build has no Firebase project and FCM never issues a token.
  assert.ok(config.mods?.android?.projectBuildGradle, 'buildscript dependency');
  assert.ok(config.mods?.android?.appBuildGradle, 'apply plugin');
  assert.equal(config.android.googleServicesFile, './google-services.json');
});

test('without GOOGLE_SERVICES_JSON, Firebase is not applied at all', () => {
  const config = withEnv(undefined, applyExampleConfig);

  assert.deepEqual(Object.keys(config.mods?.ios ?? {}), []);
  assert.deepEqual(Object.keys(config.mods?.android ?? {}), []);
  assert.equal(config.android.googleServicesFile, undefined);
});
