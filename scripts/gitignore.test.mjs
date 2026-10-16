/**
 * The credentials the setup guides have you create must never be committable.
 *
 * `git add -A` stages anything .gitignore does not cover, and this repository
 * has already published live credentials once that way (server/.env.swp).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function isIgnored(path) {
  // --no-index: decide from the patterns alone, whether or not the file exists.
  const result = spawnSync('git', ['check-ignore', '--quiet', '--no-index', path], { cwd: root });
  return result.status === 0;
}

const SECRETS = [
  // docs/push-setup.md 2b step 4: the Firebase service-account key, saved under
  // the name Firebase gives it, wherever the developer happens to put it.
  'server/my-project-firebase-adminsdk-abc12-0123456789.json',
  'my-project-firebase-adminsdk-abc12-0123456789.json',
  // Expo loads these, and in this repository .env files are the secrets files.
  'example/.env',
  'example/.env.local',
  'example/.env.development.local',
  'example/.env.production.local',
  'server/.env',
  // APNs: the .p8 key, and the VoIP Services certificate push-setup.md 1a
  // offers as the alternative, plus its usual PEM export.
  'AuthKey_ABC123DEFG.p8',
  'voip-services.p12',
  'voip-services.pem',
  // Android signing keys.
  'example/release.keystore',
  'example/upload-key.jks',
  // verify:prebuild's scratch copy.
  '.tmp/verify-prebuild/example/app.json'
];

for (const path of SECRETS) {
  test(`${path} is ignored`, () => {
    assert.ok(isIgnored(path), `${path} could be committed`);
  });
}

test('committed configuration is not ignored', () => {
  for (const path of ['example/.env.example', 'scripts/fixtures/google-services.fixture.json']) {
    assert.ok(!isIgnored(path), `${path} is ignored`);
  }
});
