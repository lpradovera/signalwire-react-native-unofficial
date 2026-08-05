const path = require('path');

const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

// Monorepo: watch the workspace root and resolve from both node_modules trees.
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules')
];
config.resolver.disableHierarchicalLookup = true;

// Required for the subpath imports `@signalwire/react-native/polyfills`,
// `/callkit` and `/audio`. Metro only honours a package's "exports" map when
// this is on; it is opt-in on Metro 0.81 (Expo SDK 52) and on by default from
// Expo SDK 53. Without it those imports fail to resolve.
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
