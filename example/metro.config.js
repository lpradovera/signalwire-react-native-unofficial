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

// Caches in the repository, not the OS temp dir. Expo roots its transform
// cache at os.tmpdir()/metro-cache and Metro's file map defaults to
// os.tmpdir(), a directory shared with every other Expo/Metro project (every
// user's, on a Linux /tmp): the bundle-check gate wrote its scratch there, and
// clearing it reset other projects. node_modules/.cache is gitignored with
// node_modules and goes with a fresh `npm ci`. The store is a new instance of
// Expo's own FileStore class (it skips caching CSS marked skipCache), taken
// from the default config so no Metro package has to be required directly.
const cacheRoot = path.join(workspaceRoot, 'node_modules', '.cache');
const ExpoFileStore = config.cacheStores[0].constructor;
config.cacheStores = [new ExpoFileStore({ root: path.join(cacheRoot, 'metro') })];
config.fileMapCacheDirectory = path.join(cacheRoot, 'metro-file-map');

module.exports = config;
