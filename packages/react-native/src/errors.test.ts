import { MissingPeerDependencyError, PolyfillNotInstalledError } from './errors';

describe('MissingPeerDependencyError', () => {
  it('names the package, the feature and the install command', () => {
    const error = new MissingPeerDependencyError('react-native-callkeep', 'native call UI');
    expect(error).toBeInstanceOf(Error);
    expect(error.packageName).toBe('react-native-callkeep');
    expect(error.feature).toBe('native call UI');
    expect(error.message).toContain('react-native-callkeep');
    expect(error.message).toContain('native call UI');
    expect(error.message).toContain('npm install react-native-callkeep');
    expect(error.name).toBe('MissingPeerDependencyError');
  });
});

describe('PolyfillNotInstalledError', () => {
  it('names the import and states it must come first', () => {
    const error = new PolyfillNotInstalledError('@signalwire/react-native/polyfills');
    expect(error.importPath).toBe('@signalwire/react-native/polyfills');
    expect(error.message).toContain('@signalwire/react-native/polyfills');
    expect(error.message).toContain('before');
    expect(error.name).toBe('PolyfillNotInstalledError');
  });
});
