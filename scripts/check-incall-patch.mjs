#!/usr/bin/env node
// Checks (or, with --write, regenerates) docs/patches/react-native-incall-manager+4.3.0.patch
// from a clone of the incall-manager fork. See docs/patches/README.md.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const patchFile = join(root, 'docs/patches/react-native-incall-manager+4.3.0.patch');
const readme = join(root, 'docs/patches/README.md');
const [repo, flag] = process.argv.slice(2);
if (!repo) {
  console.error('usage: node scripts/check-incall-patch.mjs <incall-manager clone> [--write]');
  process.exit(2);
}
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
const recorded = /source-commit: ([0-9a-f]{40})/.exec(readFileSync(readme, 'utf8'))?.[1];
const commit = flag === '--write' ? git('rev-parse', 'ios-audio-routes').trim() : recorded;
if (!commit) {
  console.error('docs/patches/README.md records no source-commit');
  process.exit(2);
}
const prefix = 'node_modules/react-native-incall-manager/';
const diff = git('diff', `--src-prefix=a/${prefix}`, `--dst-prefix=b/${prefix}`, 'master', commit, '--', 'index.d.ts', 'index.js', 'ios');
if (flag === '--write') {
  writeFileSync(patchFile, diff);
  writeFileSync(readme, readFileSync(readme, 'utf8').replace(/source-commit: [0-9a-f]{40}/, `source-commit: ${commit}`));
  console.log(`wrote the patch from ${commit}`);
} else if (diff !== readFileSync(patchFile, 'utf8')) {
  console.error(`the patch does not match ${commit}: regenerate it with --write`);
  process.exit(1);
} else {
  console.log(`the patch matches ${commit}`);
}
