/**
 * Runtime double for `@signalwire/js` used by this package's tests.
 *
 * The core is universal and owns no SDK behaviour — it wires observables into
 * React. Its tests therefore supply their own fakes, and loading the real SDK
 * would only drag in an ESM-only `uuid` that Jest cannot parse.
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
