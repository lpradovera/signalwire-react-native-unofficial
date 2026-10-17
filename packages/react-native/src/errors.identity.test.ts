/**
 * tsup builds every entry as a self-contained bundle (splitting: false), so
 * errors.ts is copied into the root, /audio and /callkit bundles. An error
 * thrown from /audio's copy must still pass `instanceof` against the class
 * the root entry exports, as the README's `catch (e) { if (e instanceof
 * MissingPeerDependencyError) ... }` assumes. Two isolated module loads stand
 * in for two bundle copies.
 */
type Errors = typeof import('./errors');

function loadCopy(): Errors {
  let copy: Errors | undefined;
  jest.isolateModules(() => {
    copy = jest.requireActual('./errors') as Errors;
  });
  return copy!;
}

describe('error identity across bundle copies', () => {
  const root = loadCopy();
  const audio = loadCopy();

  it('has two distinct copies of the class, as the bundles do', () => {
    expect(audio.MissingPeerDependencyError).not.toBe(root.MissingPeerDependencyError);
  });

  it("matches another copy's MissingPeerDependencyError with instanceof", () => {
    const error = new audio.MissingPeerDependencyError('react-native-incall-manager', 'audio routing');
    expect(error instanceof root.MissingPeerDependencyError).toBe(true);
    expect(error instanceof Error).toBe(true);
  });

  it("matches another copy's PolyfillNotInstalledError with instanceof", () => {
    const error = new audio.PolyfillNotInstalledError('@signalwire/react-native/polyfills');
    expect(error instanceof root.PolyfillNotInstalledError).toBe(true);
  });

  it('does not match other errors', () => {
    expect(new Error('x') instanceof root.MissingPeerDependencyError).toBe(false);
    expect(new audio.PolyfillNotInstalledError('p') instanceof root.MissingPeerDependencyError).toBe(false);
    expect((null as unknown) instanceof root.MissingPeerDependencyError).toBe(false);
  });
});
