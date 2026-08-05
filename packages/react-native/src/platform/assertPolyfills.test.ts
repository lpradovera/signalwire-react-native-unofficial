import { PolyfillNotInstalledError } from '../errors';

import { assertPolyfillsInstalled } from './assertPolyfills';

describe('assertPolyfillsInstalled', () => {
  const originalCrypto = globalThis.crypto;
  const originalURL = globalThis.URL;

  afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', { value: originalCrypto, configurable: true });
    Object.defineProperty(globalThis, 'URL', { value: originalURL, configurable: true });
  });

  it('passes when getRandomValues exists and URL parses a custom scheme', () => {
    expect(() => assertPolyfillsInstalled()).not.toThrow();
  });

  it('throws when crypto.getRandomValues is missing', () => {
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
    expect(() => assertPolyfillsInstalled()).toThrow(PolyfillNotInstalledError);
  });

  it('throws when URL drops a custom scheme, which is the RN built-in behaviour', () => {
    class BrokenURL {
      public protocol = '';
      public pathname = '';
    }
    Object.defineProperty(globalThis, 'URL', { value: BrokenURL, configurable: true });
    expect(() => assertPolyfillsInstalled()).toThrow(PolyfillNotInstalledError);
  });

  it('throws when URL constructor itself rejects a custom scheme', () => {
    class ThrowingURL {
      constructor() {
        throw new TypeError('Invalid URL');
      }
    }
    Object.defineProperty(globalThis, 'URL', { value: ThrowingURL, configurable: true });
    expect(() => assertPolyfillsInstalled()).toThrow(PolyfillNotInstalledError);
  });
});
