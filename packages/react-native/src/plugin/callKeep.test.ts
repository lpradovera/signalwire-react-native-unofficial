import path from 'node:path';

import { findCallKeep, isCallKeepInstalled } from './callKeep';

// Jest provides it; the package's types leave Node globals out on purpose.
declare const __dirname: string;

/**
 * A resolver for an app that has exactly `installed`. A real app root can't
 * stand in here: Node's resolution climbs to this repository's node_modules,
 * which has the fork.
 */
function appWith(installed: string[]): (request: string) => string {
  return (request) => {
    const name = installed.find((pkg) => request === `${pkg}/package.json`);
    if (name === undefined) {
      throw new Error(`Cannot find module '${request}'`);
    }
    return `/app/node_modules/${request}`;
  };
}

describe('findCallKeep', () => {
  it('finds the fork this workspace installs, by real resolution', () => {
    expect(findCallKeep(path.join(__dirname, '..', '..'))).toBe('@signalwire/react-native-callkeep');
  });

  it('finds stock react-native-callkeep', () => {
    expect(findCallKeep('/app', appWith(['react-native-callkeep']))).toBe('react-native-callkeep');
  });

  it('prefers the fork when the app has both', () => {
    expect(findCallKeep('/app', appWith(['react-native-callkeep', '@signalwire/react-native-callkeep']))).toBe(
      '@signalwire/react-native-callkeep'
    );
  });

  it('finds neither in an app without callkeep', () => {
    expect(findCallKeep('/app', appWith([]))).toBeUndefined();
  });
});

describe('isCallKeepInstalled', () => {
  it('finds callkeep where the app can resolve it', () => {
    // This workspace installs the fork as a dev dependency.
    expect(isCallKeepInstalled(path.join(__dirname, '..', '..'))).toBe(true);
  });

  it('reports it missing where nothing above the project has it', () => {
    expect(isCallKeepInstalled(path.parse(__dirname).root)).toBe(false);
  });
});
