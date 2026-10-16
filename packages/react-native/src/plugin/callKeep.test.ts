import path from 'node:path';

import { isCallKeepInstalled } from './callKeep';

// Jest provides it; the package's types leave Node globals out on purpose.
declare const __dirname: string;

describe('isCallKeepInstalled', () => {
  it('finds callkeep where the app can resolve it', () => {
    // This workspace installs it as a dev dependency.
    expect(isCallKeepInstalled(path.join(__dirname, '..', '..'))).toBe(true);
  });

  it('reports it missing where nothing above the project has it', () => {
    expect(isCallKeepInstalled(path.parse(__dirname).root)).toBe(false);
  });
});
