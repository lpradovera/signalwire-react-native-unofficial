/**
 * Runs config plugins through Expo's own mod compiler (compileModsAsync, with
 * the default iOS base mods), on a copy of the Expo SDK 54 bare template's iOS
 * files, the way `expo prebuild` does. Calling it twice on the same project is
 * a prebuild followed by a prebuild without --clean.
 *
 * The fixture in ../__fixtures__/expo-sdk54/ios is expo-template-bare-minimum
 * 54.0.53 (0BSD): its Podfile, Podfile.properties.json, AppDelegate.swift and
 * Info.plist, unchanged.
 */
const fs = require('node:fs');
const path = require('node:path');
const { compileModsAsync, withAppDelegate, withInfoPlist, withPlugins } = require('@expo/config-plugins');

const FIXTURE = path.join(__dirname, '..', '__fixtures__', 'expo-sdk54', 'ios');
// Inside the working tree, under a gitignored directory, never the system temp.
// One directory per process: node --test runs test files in parallel.
const SCRATCH = path.join(__dirname, '..', '..', 'node_modules', '.cache', 'plugin-tests', String(process.pid));

let counter = 0;

/** A fresh copy of the template's ios/ files; `edit` may change them first. */
function makeProject(name, edit = {}) {
  const root = path.join(SCRATCH, `${counter++}-${name}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.cpSync(FIXTURE, path.join(root, 'ios'), { recursive: true });
  for (const [file, change] of Object.entries(edit)) {
    const target = path.join(root, 'ios', file);
    fs.writeFileSync(target, change(fs.readFileSync(target, 'utf8')));
  }
  return root;
}

function removeProjects() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
}

/**
 * Prebuilds `root` with `plugins` and returns the generated files, plus the
 * Info.plist as the mods left it. Mods run in reverse order of the plugins, so
 * the capture plugin goes first to see the final Info.plist.
 */
async function prebuild(root, plugins, config = {}) {
  let infoPlist;
  const capture = (c) =>
    withInfoPlist(c, (plistConfig) => {
      infoPlist = JSON.parse(JSON.stringify(plistConfig.modResults));
      return plistConfig;
    });
  let expoConfig = {
    name: 'HelloWorld',
    slug: 'helloworld',
    ...config,
    ios: { bundleIdentifier: 'com.example.helloworld', ...config.ios },
    _internal: { projectRoot: root }
  };
  expoConfig = withPlugins(expoConfig, [capture, ...plugins]);
  await compileModsAsync(expoConfig, {
    projectRoot: root,
    platforms: ['ios'],
    introspect: false,
    assertMissingModProviders: true
  });
  return {
    appDelegate: fs.readFileSync(path.join(root, 'ios', 'HelloWorld', 'AppDelegate.swift'), 'utf8'),
    podfile: fs.readFileSync(path.join(root, 'ios', 'Podfile'), 'utf8'),
    infoPlist
  };
}

/** A plugin that edits AppDelegate.swift as another app's plugin might. */
function appDelegatePlugin(edit) {
  return (config) =>
    withAppDelegate(config, (delegateConfig) => {
      delegateConfig.modResults.contents = edit(delegateConfig.modResults.contents);
      return delegateConfig;
    });
}

function count(text, needle) {
  return text.split(needle).length - 1;
}

module.exports = { FIXTURE, appDelegatePlugin, count, makeProject, prebuild, removeProjects };
