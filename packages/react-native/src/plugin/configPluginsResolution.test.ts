/**
 * The plugin must load where only the app's own `expo` resolves: pnpm with
 * node-linker=isolated and hoist=false, where `@expo/config-plugins` (a
 * dependency of expo, never listed by the app) is not reachable from this
 * package. Expo's convention, and its own plugins', is `expo/config-plugins`,
 * which re-exports the copy the app's expo uses.
 */
jest.mock('@expo/config-plugins', () => {
  throw new Error("Cannot find module '@expo/config-plugins'");
});
// What expo/config-plugins is: `module.exports = require('@expo/config-plugins')`,
// resolved from expo's own directory, where it is a declared dependency.
jest.mock('expo/config-plugins', () => jest.requireActual('@expo/config-plugins'));

describe('the config plugin under a strict isolated install', () => {
  it('loads and applies through expo/config-plugins alone', () => {
    const { default: withSignalWire } = require('./withSignalWire') as typeof import('./withSignalWire');

    const config = withSignalWire({ name: 'app', slug: 'app' }, {}) as { mods?: Record<string, unknown> };

    expect(config.mods?.ios).toBeDefined();
    expect(config.mods?.android).toBeDefined();
  });
});
