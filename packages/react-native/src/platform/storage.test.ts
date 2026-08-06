import { ReactNativeStorage, resetSessionPurgeForTesting } from './storage';

import type { AsyncStorageLike } from './storage';

function createMemoryStorage(seed: Record<string, string> = {}): AsyncStorageLike & {
  dump: () => Record<string, string>;
} {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem: async (key) => map.get(key) ?? null,
    setItem: async (key, value) => void map.set(key, value),
    removeItem: async (key) => void map.delete(key),
    getAllKeys: async () => [...map.keys()],
    multiRemove: async (keys) => keys.forEach((key) => map.delete(key)),
    dump: () => Object.fromEntries(map)
  };
}

beforeEach(() => resetSessionPurgeForTesting());

describe('ReactNativeStorage', () => {
  it('namespaces local and session keys separately', async () => {
    const backing = createMemoryStorage();
    const storage = new ReactNativeStorage(backing);

    await storage.setItem('token', 'A', 'local');
    await storage.setItem('token', 'B', 'session');

    expect(await storage.getItem('token', 'local')).toBe('A');
    expect(await storage.getItem('token', 'session')).toBe('B');
    expect(Object.keys(backing.dump()).sort()).toEqual([
      'sw-rn:local:token',
      'sw-rn:session:token'
    ]);
  });

  it('purges leftover session keys once per process on construction', async () => {
    const backing = createMemoryStorage({
      'sw-rn:session:stale': 'old',
      'sw-rn:local:kept': 'keep',
      'unrelated:key': 'untouched'
    });
    const storage = new ReactNativeStorage(backing);

    expect(await storage.getItem('stale', 'session')).toBeNull();
    expect(await storage.getItem('kept', 'local')).toBe('keep');
    expect(backing.dump()['unrelated:key']).toBe('untouched');
  });

  it('does not purge again for a second adapter in the same process', async () => {
    const backing = createMemoryStorage();
    const first = new ReactNativeStorage(backing);
    await first.setItem('live', 'yes', 'session');

    const second = new ReactNativeStorage(backing);
    expect(await second.getItem('live', 'session')).toBe('yes');
  });

  it('treats a null value as a removal, matching the SDK signature', async () => {
    const backing = createMemoryStorage();
    const storage = new ReactNativeStorage(backing);

    await storage.setItem('token', 'A', 'local');
    await storage.setItem('token', null, 'local');

    expect(await storage.getItem('token', 'local')).toBeNull();
  });

  it('removeItem deletes only the requested scope', async () => {
    const backing = createMemoryStorage();
    const storage = new ReactNativeStorage(backing);

    await storage.setItem('token', 'A', 'local');
    await storage.setItem('token', 'B', 'session');
    await storage.removeItem('token', 'session');

    expect(await storage.getItem('token', 'local')).toBe('A');
    expect(await storage.getItem('token', 'session')).toBeNull();
  });

  it('clear removes every key in the scope and nothing else', async () => {
    const backing = createMemoryStorage({ 'unrelated:key': 'untouched' });
    const storage = new ReactNativeStorage(backing);

    await storage.setItem('a', '1', 'local');
    await storage.setItem('b', '2', 'local');
    await storage.setItem('c', '3', 'session');
    await storage.clear('local');

    expect(await storage.getItem('a', 'local')).toBeNull();
    expect(await storage.getItem('b', 'local')).toBeNull();
    expect(await storage.getItem('c', 'session')).toBe('3');
    expect(backing.dump()['unrelated:key']).toBe('untouched');
  });

  it('resolves reads to null when the backing store rejects', async () => {
    const backing = createMemoryStorage();
    backing.getItem = async () => {
      throw new Error('disk full');
    };
    const storage = new ReactNativeStorage(backing);

    await expect(storage.getItem('token', 'local')).resolves.toBeNull();
  });

  it('does not reject when a write fails', async () => {
    const backing = createMemoryStorage();
    backing.setItem = async () => {
      throw new Error('disk full');
    };
    const storage = new ReactNativeStorage(backing);

    await expect(storage.setItem('token', 'A', 'local')).resolves.toBeUndefined();
  });

  /**
   * The peer floor is `>=1.23.0`, not `>=2.0.0`: Expo SDK 52 pins AsyncStorage
   * to 1.23.1, and `AsyncStorageLike` needs only five methods that 1.x already
   * provides. 1.x declares each with a trailing optional Node-style callback,
   * so `AsyncStorage123` below is copied from its `types.d.ts`. Assigning it to
   * `AsyncStorageLike` is the real assertion — it stops compiling the moment
   * the contract outgrows 1.23, at which point the floor has to move with it.
   */
  it('works against the AsyncStorage 1.23 method surface', async () => {
    interface AsyncStorage123 {
      getItem(
        key: string,
        callback?: (error?: Error, result?: string) => void
      ): Promise<string | null>;
      setItem(key: string, value: string, callback?: (error?: Error) => void): Promise<void>;
      removeItem(key: string, callback?: (error?: Error) => void): Promise<void>;
      getAllKeys(
        callback?: (error?: Error, keys?: readonly string[]) => void
      ): Promise<readonly string[]>;
      multiRemove(keys: readonly string[], callback?: (errors?: Error[]) => void): Promise<void>;
    }

    const map = new Map<string, string>();
    const legacy: AsyncStorage123 = {
      getItem: async (key) => map.get(key) ?? null,
      setItem: async (key, value) => void map.set(key, value),
      removeItem: async (key) => void map.delete(key),
      getAllKeys: async () => [...map.keys()],
      multiRemove: async (keys) => keys.forEach((key) => map.delete(key))
    };

    const backing: AsyncStorageLike = legacy;
    const storage = new ReactNativeStorage(backing);

    await storage.setItem('token', 'A', 'local');
    expect(await storage.getItem('token', 'local')).toBe('A');

    await storage.removeItem('token', 'local');
    expect(await storage.getItem('token', 'local')).toBeNull();
  });
});
