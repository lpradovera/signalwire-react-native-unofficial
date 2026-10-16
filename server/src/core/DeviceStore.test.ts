import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { JsonFileDeviceStore } from './DeviceStore.js';

// Scratch under the package's own gitignored .data/, never a machine-wide temp.
const scratchRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.data');
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(join(scratchRoot, 'store-test-'));
after(() => rm(scratch, { recursive: true, force: true }));

const ios = {
  externalUserId: 'rn-example',
  platform: 'ios' as const,
  token: 'pushkit-1',
  environment: 'sandbox' as const
};

describe('JsonFileDeviceStore', () => {
  it('starts empty when the file does not exist yet', async () => {
    const store = await JsonFileDeviceStore.open(join(scratch, 'missing', 'devices.json'));
    assert.deepEqual(await store.all(), []);
  });

  it('survives a restart: what was registered is there on reopen', async () => {
    const path = join(scratch, 'nested', 'devices.json');
    const first = await JsonFileDeviceStore.open(path);
    await first.register(ios);

    const reopened = await JsonFileDeviceStore.open(path);
    const devices = await reopened.findByUser('rn-example');
    assert.equal(devices.length, 1);
    assert.equal(devices[0]?.token, 'pushkit-1');
  });

  it('persists a removal', async () => {
    const path = join(scratch, 'remove.json');
    const store = await JsonFileDeviceStore.open(path);
    await store.register(ios);
    assert.equal(await store.remove('pushkit-1'), true);

    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), []);
    assert.deepEqual(await (await JsonFileDeviceStore.open(path)).all(), []);
  });

  it('refuses to start on a corrupt file rather than silently forgetting every device', async () => {
    const path = join(scratch, 'corrupt.json');
    await writeFile(path, '{not json', 'utf8');
    await assert.rejects(JsonFileDeviceStore.open(path), SyntaxError);
  });

  it('leaves a readable, current file after overlapping writes (server-15)', async () => {
    // Each register/remove rewrote the file in place, unserialised. With a
    // store of about 1 MB (written in chunks), a long write overlapped by a
    // shorter one left valid JSON followed by the tail of the longer one, and
    // the next open() died with a SyntaxError. The old code tore about one
    // round in three here.
    for (let round = 0; round < 10; round++) {
      const path = join(scratch, `big-${round}.json`);
      const seed = Array.from({ length: 4000 }, (_, i) => ({
        externalUserId: `user-${i}-${'y'.repeat(150)}`,
        platform: 'android',
        token: `seed-${i}`,
        environment: 'production',
        updatedAt: 0
      }));
      await writeFile(path, JSON.stringify(seed), 'utf8');
      const store = await JsonFileDeviceStore.open(path);

      const writes: Array<Promise<unknown>> = [store.register({ ...ios, token: 'new-1' })];
      await new Promise((resolve) => setTimeout(resolve, round % 5));
      for (let i = 0; i < 10; i++) {
        writes.push(store.remove(`seed-${i}`));
      }
      await Promise.all(writes);

      const reopened = await JsonFileDeviceStore.open(path);
      const tokens = (await reopened.all()).map((device) => device.token);
      assert.equal(tokens.length, 3991, `round ${round}`);
      assert.ok(tokens.includes('new-1'));
      assert.ok(!tokens.includes('seed-0'));
    }
  });
});
