/**
 * verify:prebuild must not touch the developer's own native projects.
 *
 * It runs a real `expo prebuild --clean`. Run in example/ itself, that wiped
 * example/ios and example/android — Pods, signing edits, the google-services
 * file — and regenerated them for the placeholder bundle id, which the next
 * `expo run:ios` then reused as-is.
 *
 * Slow (two real prebuilds), so it is not part of `npm test`:
 *   node --test scripts/verify-prebuild.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const example = join(root, 'example');

test('verify:prebuild leaves example/ios and example/android as they were', { timeout: 600_000 }, () => {
  const created = [];
  for (const platform of ['ios', 'android']) {
    const dir = join(example, platform);
    if (!existsSync(dir)) {
      mkdirSync(dir);
      created.push(dir);
    }
    writeFileSync(join(dir, 'DEVELOPER-EDIT'), platform);
  }

  try {
    execFileSync(process.execPath, [join(root, 'scripts/verify-prebuild.mjs')], {
      cwd: root,
      stdio: 'pipe'
    });

    for (const platform of ['ios', 'android']) {
      const marker = join(example, platform, 'DEVELOPER-EDIT');
      assert.ok(existsSync(marker), `example/${platform} was wiped`);
      assert.equal(readFileSync(marker, 'utf8'), platform);
    }
    assert.ok(!existsSync(join(example, 'ios', 'Podfile')), 'example/ios was regenerated');
    assert.ok(
      !existsSync(join(example, 'android', 'app')),
      'example/android was regenerated'
    );
  } finally {
    for (const platform of ['ios', 'android']) {
      rmSync(join(example, platform, 'DEVELOPER-EDIT'), { force: true });
    }
    for (const dir of created) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
