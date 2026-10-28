/**
 * Which callkeep the package uses: `@signalwire/react-native-callkeep` (the
 * SignalWire fork) when the app has it, else stock `react-native-callkeep`.
 *
 * Both are optional peers, so either may be missing. The choice is made while
 * `callkeepModule` is evaluated, inside a try, the way the Firebase loader
 * does it: Metro bundles a `require` in a try as an optional dependency, and a
 * throw from it reaches the catch only during a module's own evaluation (a
 * later require is outside every load guard, and a release build dies).
 */
import { MissingPeerDependencyError } from '../errors';

type CallKeepModule = typeof import('./callkeepModule');

const SCOPED = '@signalwire/react-native-callkeep';
const STOCK = 'react-native-callkeep';

/** A stand-in callkeep: its default export and CONSTANTS, tagged by package. */
function fakeCallKeep(name: string, evaluations: string[]) {
  return () => {
    evaluations.push(name);
    return {
      __esModule: true,
      default: { name, setup: jest.fn() },
      CONSTANTS: { END_CALL_REASONS: { FAILED: name === SCOPED ? 1 : 101 } }
    };
  };
}

/** What Metro's and Jest's require do for a package the app did not install. */
function notInstalled(name: string, evaluations: string[]) {
  return () => {
    evaluations.push(name);
    throw new Error(`Cannot find module '${name}'`);
  };
}

function load(scoped: 'installed' | 'missing', stock: 'installed' | 'missing') {
  const evaluations: string[] = [];
  let loaded!: CallKeepModule;
  jest.isolateModules(() => {
    jest.doMock(SCOPED, scoped === 'installed' ? fakeCallKeep(SCOPED, evaluations) : notInstalled(SCOPED, evaluations));
    jest.doMock(STOCK, stock === 'installed' ? fakeCallKeep(STOCK, evaluations) : notInstalled(STOCK, evaluations), {
      virtual: true
    });
    loaded = require('./callkeepModule') as CallKeepModule;
  });
  return { loaded, evaluations };
}

afterEach(() => {
  jest.dontMock(SCOPED);
  jest.dontMock(STOCK);
});

describe('callkeepModule', () => {
  it('prefers the SignalWire fork when both are installed, and leaves stock unevaluated', () => {
    const { loaded, evaluations } = load('installed', 'installed');
    expect(loaded.getCallKeep()?.packageName).toBe(SCOPED);
    expect((loaded.getCallKeep()?.module as unknown as { name: string }).name).toBe(SCOPED);
    expect(loaded.getCallKeep()?.constants.END_CALL_REASONS.FAILED).toBe(1);
    expect(evaluations).toEqual([SCOPED]);
  });

  it('falls back to stock react-native-callkeep when the fork is not installed', () => {
    const { loaded } = load('missing', 'installed');
    expect(loaded.getCallKeep()?.packageName).toBe(STOCK);
    expect((loaded.getCallKeep()?.module as unknown as { name: string }).name).toBe(STOCK);
    expect(loaded.getCallKeep()?.constants.END_CALL_REASONS.FAILED).toBe(101);
  });

  it('loads without throwing when neither is installed', () => {
    const { loaded } = load('missing', 'missing');
    expect(loaded.getCallKeep()).toBeUndefined();
  });

  it('resolves once, while the module is evaluated, never on a later call', () => {
    const { loaded, evaluations } = load('missing', 'installed');
    expect(evaluations).toEqual([SCOPED, STOCK]);
    loaded.getCallKeep();
    loaded.getCallKeep();
    expect(evaluations).toEqual([SCOPED, STOCK]);
  });

  describe('requireCallKeep', () => {
    it('returns the resolved callkeep', () => {
      const { loaded } = load('installed', 'missing');
      expect(loaded.requireCallKeep('native call UI').packageName).toBe(SCOPED);
    });

    it('names both packages, the fork first, when neither is installed', () => {
      const { loaded } = load('missing', 'missing');
      let thrown: unknown;
      try {
        loaded.requireCallKeep('native call UI');
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(MissingPeerDependencyError);
      const error = thrown as MissingPeerDependencyError;
      expect(error.packageName).toBe(SCOPED);
      expect(error.feature).toBe('native call UI');
      expect(error.message).toContain(`npm install ${SCOPED}`);
      expect(error.message).toContain(STOCK);
      expect(error.message.indexOf(SCOPED)).toBeLessThan(error.message.indexOf(`"${STOCK}"`));
    });

    it('says why when a callkeep was found but failed to load', () => {
      // An installed but unlinked callkeep throws on iOS while it is
      // evaluated: `new NativeEventEmitter(null)` fails an invariant.
      const evaluations: string[] = [];
      let loaded!: CallKeepModule;
      jest.isolateModules(() => {
        jest.doMock(SCOPED, () => {
          throw new Error('Invariant Violation: `new NativeEventEmitter()` requires a non-null argument.\n    at stack');
        });
        jest.doMock(STOCK, notInstalled(STOCK, evaluations), { virtual: true });
        loaded = require('./callkeepModule') as CallKeepModule;
      });
      expect(loaded.getCallKeep()).toBeUndefined();
      expect(() => loaded.requireCallKeep('native call UI')).toThrow(
        /@signalwire\/react-native-callkeep failed to load: Invariant Violation: `new NativeEventEmitter\(\)` requires a non-null argument\.$/m
      );
    });
  });
});
