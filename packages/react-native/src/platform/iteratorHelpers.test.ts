import { installIteratorHelpers } from './iteratorHelpers';

describe('installIteratorHelpers', () => {
  beforeAll(() => installIteratorHelpers());

  // The exact call that crashed the app: DirectoryManager does
  // `Array.from(map.values().map((a) => a.id))`.
  it('supports map on a Map iterator, as the SDK calls it', () => {
    const m = new Map([['a', { id: 1 }], ['b', { id: 2 }]]);
    expect(Array.from((m.values() as any).map((v: { id: number }) => v.id))).toEqual([1, 2]);
  });

  it('supports find on a Map iterator, as the SDK calls it', () => {
    const m = new Map([['a', { name: 'x' }], ['b', { name: 'y' }]]);
    expect((m.values() as any).find((v: { name: string }) => v.name === 'y')).toEqual({ name: 'y' });
    expect((m.values() as any).find(() => false)).toBeUndefined();
  });

  it('covers the neighbouring helpers', () => {
    expect(Array.from(([1, 2, 3, 4][Symbol.iterator]() as any).filter((n: number) => n % 2 === 0))).toEqual([2, 4]);
    expect(Array.from(([1, 2, 3][Symbol.iterator]() as any).take(2))).toEqual([1, 2]);
    expect(Array.from(([1, 2, 3][Symbol.iterator]() as any).drop(1))).toEqual([2, 3]);
    expect(([1, 2, 3][Symbol.iterator]() as any).reduce((a: number, b: number) => a + b)).toBe(6);
    expect(([1, 2, 3][Symbol.iterator]() as any).some((n: number) => n === 2)).toBe(true);
    expect(([1, 2, 3][Symbol.iterator]() as any).every((n: number) => n > 0)).toBe(true);
    expect(([1, 2][Symbol.iterator]() as any).toArray()).toEqual([1, 2]);
  });

  it('does not replace a native implementation', () => {
    const proto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
    const sentinel = function sentinel() { return 'native'; };
    Object.defineProperty(proto, 'map', { value: sentinel, writable: true, configurable: true });
    installIteratorHelpers();
    expect(proto.map).toBe(sentinel);
    delete proto.map;
    installIteratorHelpers();
  });
});
