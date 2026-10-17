// The @signalwire/js 4.0.0-rc.5 hold patch (patches/@signalwire+js+4.0.0-rc.5.patch)
// is applied by the root postinstall (patch-package). See the patch's comments
// and docs/patches/README.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
// The main entry is dist/index.cjs; the package exports no ./package.json.
const sdkDir = join(dirname(require.resolve('@signalwire/js')), '..');
const version = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8')).version;

test('the patch matches the installed @signalwire/js', () => {
  assert.equal(version, '4.0.0-rc.5', 'a new SDK version: re-check the hold fixes and regenerate or drop the patch');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.postinstall, 'patch-package');
});

for (const file of ['index.mjs', 'index.cjs']) {
  test(`${file} has both hold fixes`, () => {
    const source = readFileSync(join(sdkDir, 'dist', file), 'utf8');
    assert.match(source, /await this\._pauseLocalMediaForHold\(this\._holdState\);/);
    assert.match(source, /if \(this\._holdState \|\| this\._holdReleasedAt !== void 0 && Date\.now\(\) - this\._holdReleasedAt < 5e3\) return;/);
  });
}

test('a held call stops sending: its senders are deactivated and reactivated', async () => {
  const { WebRTCCall } = require('@signalwire/js');
  const log = [];
  let active = true;
  const sender = {
    track: { id: 'mic', kind: 'audio' },
    getParameters: () => ({ transactionId: 't', encodings: [{ active }] }),
    setParameters: async (parameters) => {
      active = parameters.encodings[0].active;
      log.push(`active ${active}`);
    }
  };
  const call = {
    _holdState: false,
    vertoManager: {
      hold: async () => log.push('verto hold'),
      unhold: async () => log.push('verto unhold')
    },
    rtcPeerConnection: { getSenders: () => [sender] },
    _pauseLocalMediaForHold: WebRTCCall.prototype._pauseLocalMediaForHold
  };

  await WebRTCCall.prototype.toggleHold.call(call);
  assert.deepEqual(log, ['verto hold', 'active false']);
  assert.equal(call._holdState, true);

  await WebRTCCall.prototype.toggleHold.call(call);
  assert.deepEqual(log, ['verto hold', 'active false', 'verto unhold', 'active true']);
  assert.equal(call._holdState, false);
  assert.equal(typeof call._holdReleasedAt, 'number');
});
