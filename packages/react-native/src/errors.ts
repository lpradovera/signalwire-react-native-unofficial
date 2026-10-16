/** Thrown when an optional peer dependency is absent or not natively linked. */
export class MissingPeerDependencyError extends Error {
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
  }
}

/** Thrown when a required side-effect polyfill import did not run. */
export class PolyfillNotInstalledError extends Error {
  constructor(public readonly importPath: string) {
    super(
      `Missing required polyfills. Add \`import '${importPath}';\` as the very ` +
        `first line of your app entry file, before any import of "@signalwire/js" ` +
        `or "@signalwire/react-native".`
    );
    this.name = 'PolyfillNotInstalledError';
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
