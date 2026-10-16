// The example's Metro caches live in the repository, not in the OS temp dir.
// Expo's default config roots its transform cache at os.tmpdir()/metro-cache
// and Metro's file map defaults to os.tmpdir() too: a directory every other
// Expo/Metro project of the user (every user's, on a Linux /tmp) shares, so
// the bundle-check gate wrote its scratch there and a cache reset reached
// other projects.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const config = require(join(repo, 'example', 'metro.config.js'));
const cacheRoot = join(repo, 'node_modules', '.cache');

const inside = (child, parent) => {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep);
};

test('the transform cache writes under node_modules/.cache/metro', async () => {
  assert.equal(config.cacheStores.length, 1);
  const [store] = config.cacheStores;
  // FileStore keeps its root private, so write an entry and look for it.
  // Its layout: <root>/<first key byte, hex>/<rest of the key, hex>.
  const key = randomBytes(20);
  const entry = join(key.subarray(0, 1).toString('hex'), key.subarray(1).toString('hex'));
  const expected = join(cacheRoot, 'metro', entry);
  const shared = join(tmpdir(), 'metro-cache', entry);
  try {
    await store.set(key, { probe: true });
    assert.ok(existsSync(expected), `the entry is not under ${join(cacheRoot, 'metro')}`);
    assert.ok(!existsSync(shared), 'the entry went to the OS temp dir');
    assert.deepEqual(await store.get(key), { probe: true });
  } finally {
    rmSync(expected, { force: true });
    rmSync(shared, { force: true });
  }
});

test('the file-map cache is under node_modules/.cache', () => {
  const dir = config.fileMapCacheDirectory;
  assert.ok(typeof dir === 'string' && inside(dir, cacheRoot), `fileMapCacheDirectory ${dir} is not under ${cacheRoot}`);
});
