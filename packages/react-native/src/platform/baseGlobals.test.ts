import { installBaseGlobals } from './baseGlobals';

type Mutable = Record<string, unknown>;

describe('installBaseGlobals', () => {
  const root = globalThis as unknown as Mutable;
  const originalCustomEvent = root.CustomEvent;
  const originalWindow = root.window;
  const originalDocument = root.document;

  afterEach(() => {
    root.CustomEvent = originalCustomEvent;
    root.window = originalWindow;
    root.document = originalDocument;
  });

  it('defines CustomEvent when the runtime lacks it, as Hermes does', () => {
    delete root.CustomEvent;
    installBaseGlobals();
    expect(typeof root.CustomEvent).toBe('function');
  });

  it('builds a CustomEvent carrying its type and detail', () => {
    delete root.CustomEvent;
    installBaseGlobals();
    const Ctor = root.CustomEvent as new (t: string, o?: { detail?: unknown }) => {
      type: string;
      detail: unknown;
    };
    const event = new Ctor('signalwire:js:ready', { detail: { version: '4' } });
    expect(event.type).toBe('signalwire:js:ready');
    expect(event.detail).toEqual({ version: '4' });
  });

  it('gives window a working dispatchEvent, which the SDK calls at import time', () => {
    root.window = {};
    installBaseGlobals();

    const win = root.window as {
      addEventListener: (t: string, l: (e: { type: string }) => void) => void;
      dispatchEvent: (e: { type: string }) => boolean;
    };
    const heard = jest.fn();
    win.addEventListener('signalwire:js:ready', heard);
    win.dispatchEvent({ type: 'signalwire:js:ready' });

    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('never replaces an existing implementation', () => {
    const existing = jest.fn(() => true);
    root.window = { dispatchEvent: existing };
    installBaseGlobals();
    expect((root.window as Mutable).dispatchEvent).toBe(existing);
  });

  it('is idempotent', () => {
    root.window = {};
    installBaseGlobals();
    const first = (root.window as Mutable).dispatchEvent;
    installBaseGlobals();
    expect((root.window as Mutable).dispatchEvent).toBe(first);
  });

  it('also prepares document, which the visibility shim builds on', () => {
    delete root.document;
    installBaseGlobals();
    expect(typeof (root.document as Mutable).addEventListener).toBe('function');
  });
});
