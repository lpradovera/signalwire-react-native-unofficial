import { MissingPeerDependencyError } from '../errors';

import { assertPeerModule } from './peers';

describe('assertPeerModule', () => {
  it('returns the module when the required member is present', () => {
    const mod = { startCall: () => undefined };
    expect(assertPeerModule(mod, 'react-native-callkeep', 'native call UI', 'startCall')).toBe(mod);
  });

  it('throws when the module is undefined', () => {
    expect(() =>
      assertPeerModule(undefined, 'react-native-callkeep', 'native call UI', 'startCall')
    ).toThrow(MissingPeerDependencyError);
  });

  it('throws when the module is null', () => {
    expect(() =>
      assertPeerModule(null, 'react-native-callkeep', 'native call UI', 'startCall')
    ).toThrow(MissingPeerDependencyError);
  });

  it('throws when the required member is missing, which means it is not linked', () => {
    expect(() =>
      assertPeerModule({}, 'react-native-callkeep', 'native call UI', 'startCall')
    ).toThrow(/not available/);
  });
});
