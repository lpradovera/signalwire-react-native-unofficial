/**
 * Runtime double for `@signalwire/js` used by this package's unit tests.
 *
 * The core wires the SDK's observables into React, and most of its tests
 * only need the module's shape. Where the SDK's real behaviour matters
 * (destroy() that throws before connect, a session that appears only when
 * connect() finishes, deferred emissions), the tests load the real client
 * instead: see jest/realSdk.ts.
 *
 * Type correctness against the real SDK is covered by `tsc --noEmit`, which
 * resolves the genuine package.
 */
export class SignalWire {
  constructor(
    public credentialProvider?: unknown,
    public options?: unknown
  ) {}
}

const noopLogger = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined
};

export const getLogger = (): typeof noopLogger => noopLogger;
