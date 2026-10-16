/**
 * AsyncStorage 3.x (3.1.1 is npm's latest, inside the >=1.23.0 peer range)
 * dropped multiRemove: its default export has getItem, setItem, removeItem,
 * getMany, setMany, removeMany, getAllKeys and clear (lib/typescript/
 * AsyncStorage.d.ts in the published 3.1.1 tarball).
 */
import { ReactNativeStorage, resetSessionPurgeForTesting } from './storage';

import type { AsyncStorageLike } from './storage';

/** The shape of AsyncStorage 3.x's default export. */
function createAsyncStorage3(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem: async (key: string) => map.get(key) ?? null,
    setItem: async (key: string, value: string) => void map.set(key, value),
    removeItem: async (key: string) => void map.delete(key),
    getMany: async (keys: string[]) => Object.fromEntries(keys.map((key) => [key, map.get(key) ?? null])),
    setMany: async (entries: Record<string, string>) =>
      Object.entries(entries).forEach(([key, value]) => map.set(key, value)),
    removeMany: jest.fn(async (keys: string[]) => keys.forEach((key) => map.delete(key))),
    getAllKeys: async () => [...map.keys()],
    clear: async () => map.clear(),
    dump: () => Object.fromEntries(map)
  };
}

beforeEach(() => resetSessionPurgeForTesting());

describe('ReactNativeStorage on AsyncStorage 3.x', () => {
  it('purges the previous process session keys at start', async () => {
    const backing = createAsyncStorage3({
      'sw-rn:session:as': 'old-authorization-state',
      'sw-rn:local:kept': 'keep'
    });
    const storage = new ReactNativeStorage(backing as AsyncStorageLike);

    expect(await storage.getItem('as', 'session')).toBeNull();
    expect(backing.dump()).toEqual({ 'sw-rn:local:kept': 'keep' });
    expect(backing.removeMany).toHaveBeenCalledWith(['sw-rn:session:as']);
  });

  it('clears a scope (the SDK resetToDefaults wipe)', async () => {
    const backing = createAsyncStorage3({ 'unrelated:key': 'untouched' });
    const storage = new ReactNativeStorage(backing as AsyncStorageLike);
    await storage.setItem('cached_credential', 'sat', 'local');
    await storage.setItem('other', 'x', 'local');

    await storage.clear('local');

    expect(await storage.getItem('cached_credential', 'local')).toBeNull();
    expect(backing.dump()).toEqual({ 'unrelated:key': 'untouched' });
  });

  it('falls back to removeItem when the store has neither bulk remove', async () => {
    const backing = createAsyncStorage3({ 'sw-rn:local:a': '1', 'sw-rn:local:b': '2' });
    const minimal: AsyncStorageLike = {
      getItem: backing.getItem,
      setItem: backing.setItem,
      removeItem: backing.removeItem,
      getAllKeys: backing.getAllKeys
    };
    const storage = new ReactNativeStorage(minimal);

    await storage.clear('local');

    expect(backing.dump()).toEqual({});
  });
});
