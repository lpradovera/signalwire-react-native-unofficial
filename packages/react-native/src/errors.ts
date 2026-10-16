/**
 * Brands for `instanceof` across bundle copies.
 *
 * tsup builds each entry point as a self-contained bundle, so this file is
 * copied into the root, `/audio` and `/callkit` bundles, and each copy has its
 * own class. Without this, an error thrown by `/audio` would fail
 * `instanceof MissingPeerDependencyError` with the class imported from the
 * root entry. `Symbol.for` is shared by the whole realm, so every copy reads
 * the same brand.
 */
const MISSING_PEER = Symbol.for('@signalwire/react-native:MissingPeerDependencyError');
const POLYFILL_MISSING = Symbol.for('@signalwire/react-native:PolyfillNotInstalledError');

function brand(target: object, key: symbol): void {
  Object.defineProperty(target, key, { value: true });
}

/**
 * The brand, or the ordinary prototype check. The latter is still needed:
 * Babel's class transform checks `this instanceof Class` before the
 * constructor has set the brand.
 */
function isInstance(ctor: unknown, value: unknown, key: symbol): boolean {
  if (typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[key] === true) {
    return true;
  }
  return Function.prototype[Symbol.hasInstance].call(ctor, value);
}

/** Thrown when an optional peer dependency is absent or not natively linked. */
export class MissingPeerDependencyError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    return isInstance(this, value, MISSING_PEER);
  }

  constructor(
    public readonly packageName: string,
    public readonly feature: string
  ) {
    super(
      `${feature} requires "${packageName}", which is not available. ` +
        `Run \`npm install ${packageName}\` and rebuild the native app ` +
        `(\`npx expo prebuild --clean\` or a fresh pod install / gradle build). ` +
        `A package that is installed but not linked produces this same error.`
    );
    this.name = 'MissingPeerDependencyError';
    brand(this, MISSING_PEER);
  }
}

/** Thrown when a required side-effect polyfill import did not run. */
export class PolyfillNotInstalledError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    return isInstance(this, value, POLYFILL_MISSING);
  }

  constructor(public readonly importPath: string) {
    super(
      `Missing required polyfills. Add \`import '${importPath}';\` as the very ` +
        `first line of your app entry file, before any import of "@signalwire/js" ` +
        `or "@signalwire/react-native".`
    );
    this.name = 'PolyfillNotInstalledError';
    brand(this, POLYFILL_MISSING);
  }
}

/**
 * Thrown when an outbound call is started while another call is live.
 *
 * CallKit is set up for one call at a time (`maximumCallGroups: 1`) and
 * refuses a second start transaction, but react-native-callkeep only logs
 * that refusal, so the second call would run with no native call UI and
 * nothing to end it from. `useSignalWire().dial()` therefore rejects with
 * this before the SDK places anything, while CallKit is on. Hang up (or wait
 * for) the live call first. Answering a push by dialling a bridge is not
 * refused: that call belongs to the entry already on screen.
 */
export class CallInProgressError extends Error {
  constructor(
    /** The native UUID of the call that is live. */
    public readonly liveCallUuid: string
  ) {
    super(
      `A call is already in progress (${liveCallUuid}). End it before starting another: ` +
        'native call UI runs one call at a time.'
    );
    this.name = 'CallInProgressError';
  }
}
