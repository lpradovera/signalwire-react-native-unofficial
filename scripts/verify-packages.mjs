#!/usr/bin/env node
// Packs each published package and checks the manifest inside the tarball:
// the four @signalwire/* packages are released in lockstep, so each must
// carry the same version, depend on the others at exactly `^<that version>`,
// and publish under the `alpha` dist-tag, so a publish can never take
// `latest` (SignalWire's 1.x SDK) by accident. See RELEASING.md.
//
// Run after `npm run build` (verify:package does both).
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['@signalwire/react', '@signalwire/react-ui', '@signalwire/react-native', '@signalwire/react-native-ui'];
const TAG = 'alpha';

const scratch = join(root, '.tmp', 'verify-packages');
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

const problems = [];
const manifests = new Map();
try {
  for (const name of PACKAGES) {
    const out = execFileSync('npm', ['pack', '-w', name, '--pack-destination', scratch, '--json', '--silent'], {
      cwd: root,
      encoding: 'utf8'
    });
    const [packed] = JSON.parse(out);
    const json = execFileSync('tar', ['-xzOf', join(scratch, packed.filename), 'package/package.json'], {
      encoding: 'utf8'
    });
    manifests.set(name, { file: packed.filename, manifest: JSON.parse(json) });
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const version = manifests.get(PACKAGES[0]).manifest.version;
const range = `^${version}`;
for (const [name, { file, manifest }] of manifests) {
  const where = `${file}:`;
  if (manifest.name !== name) {
    problems.push(`${where} name is ${manifest.name}, expected ${name}`);
  }
  if (manifest.version !== version) {
    problems.push(`${where} version ${manifest.version}, expected ${version} (the packages are released in lockstep)`);
  }
  if (manifest.publishConfig?.tag !== TAG) {
    problems.push(`${where} publishConfig.tag is ${JSON.stringify(manifest.publishConfig?.tag)}, expected "${TAG}"`);
  }
  if (manifest.publishConfig?.access !== 'public') {
    problems.push(`${where} publishConfig.access is ${JSON.stringify(manifest.publishConfig?.access)}, expected "public"`);
  }
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [dep, spec] of Object.entries(manifest[section] ?? {})) {
      if (PACKAGES.includes(dep) && spec !== range) {
        problems.push(`${where} ${section}.${dep} is ${spec}, expected ${range}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`verify-packages: ${problems.length} problem(s)`);
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  process.exit(1);
}
console.log(
  `verify-packages: ${PACKAGES.length} tarballs at ${version}, inter-package ranges ${range}, publishConfig.tag "${TAG}"`
);
