/**
 * The polyfill itself, as Hermes runs it. Under jest (node 24) V8's native
 * helpers are present and installIteratorHelpers() skips them, so these
 * tests remove the natives from %IteratorPrototype% first and put them back
 * afterwards.
 */
import { installIteratorHelpers } from './iteratorHelpers';

const HELPERS = ['map', 'filter', 'flatMap', 'take', 'drop', 'find', 'some', 'every', 'forEach', 'reduce', 'toArray'];
const proto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())) as Record<string, unknown>;
const natives = new Map<string, PropertyDescriptor>();

beforeAll(() => {
  for (const name of HELPERS) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (descriptor) {
      natives.set(name, descriptor);
      delete proto[name];
    }
  }
  installIteratorHelpers();
});

afterAll(() => {
  for (const name of HELPERS) {
    delete proto[name];
  }
  for (const [name, descriptor] of natives) {
    Object.defineProperty(proto, name, descriptor);
  }
});

/** A source that records whether it was closed, like a generator's finally. */
function source(values: unknown[]): Iterator<unknown> & { closed: boolean } {
  let index = 0;
  const iterator = Object.create(proto) as Iterator<unknown> & { closed: boolean };
  iterator.closed = false;
  iterator.next = () =>
    index < values.length ? { value: values[index++], done: false } : { value: undefined, done: true };
  iterator.return = () => {
    iterator.closed = true;
    return { value: undefined, done: true };
  };
  return iterator;
}

type Helpers = {
  map: (fn: unknown) => Iterator<unknown> & Iterable<unknown>;
  find: (fn: unknown) => unknown;
};
const helpers = (iterator: Iterator<unknown>): Helpers => iterator as unknown as Helpers;

describe('the iterator-helper polyfill (Hermes)', () => {
  it('maps a Map iterator, as the SDK calls it', () => {
    const m = new Map([['a', { id: 1 }], ['b', { id: 2 }]]);
    expect(Array.from(helpers(m.values()).map((v: { id: number }) => v.id))).toEqual([1, 2]);
  });

  it('passes the index to the mapper', () => {
    expect(Array.from(helpers(source(['a', 'b'])).map((v: string, i: number) => `${v}${i}`))).toEqual([
      'a0',
      'b1'
    ]);
  });

  it('finds on a Map iterator, as the SDK calls it', () => {
    const m = new Map([['a', { name: 'x' }], ['b', { name: 'y' }]]);
    expect(helpers(m.values()).find((v: { name: string }) => v.name === 'y')).toEqual({ name: 'y' });
    expect(helpers(m.values()).find(() => false)).toBeUndefined();
  });

  it('throws for a non-callable argument at the call, not on first next()', () => {
    expect(() => helpers(source([1])).map(undefined)).toThrow(TypeError);
    expect(() => helpers(source([1])).find(undefined)).toThrow(TypeError);
  });

  it('closes the source when a map helper is returned before its first next()', () => {
    const it = source([1, 2]);
    const mapped = helpers(it).map((v: number) => v);
    mapped.return?.();
    expect(it.closed).toBe(true);
    expect(mapped.next()).toEqual({ value: undefined, done: true });
  });

  it('closes the source when the mapper throws', () => {
    const it = source([1, 2]);
    const mapped = helpers(it).map(() => {
      throw new Error('boom');
    });
    expect(() => mapped.next()).toThrow('boom');
    expect(it.closed).toBe(true);
  });

  it('closes the source once find has its answer', () => {
    const it = source([1, 2, 3]);
    expect(helpers(it).find((v: number) => v === 2)).toBe(2);
    expect(it.closed).toBe(true);
  });

  it('installs only the helpers the SDK calls', () => {
    // A partial, non-standard take/drop/flatMap on the realm-wide prototype
    // gave app code different results on Hermes than on V8 or JSC.
    for (const name of ['filter', 'flatMap', 'take', 'drop', 'some', 'every', 'forEach', 'reduce', 'toArray']) {
      expect(proto[name]).toBeUndefined();
    }
  });
});
