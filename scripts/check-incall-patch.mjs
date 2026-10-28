#!/usr/bin/env node
// Checks (or, with --write, regenerates) docs/patches/react-native-incall-manager+4.3.0.patch
// from a clone of the incall-manager fork. See docs/patches/README.md.
//
//   node scripts/check-incall-patch.mjs <clone>                  check against the recorded commit
//   node scripts/check-incall-patch.mjs <clone> --write [<ref>]  regenerate from <ref> (default: the
//                                                                ios-audio-routes branch, local or remote)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const patchFile = join(root, 'docs/patches/react-native-incall-manager+4.3.0.patch');
const readme = join(root, 'docs/patches/README.md');
const [repo, flag, ref] = process.argv.slice(2);
if (!repo || (flag !== undefined && flag !== '--write')) {
  console.error('usage: node scripts/check-incall-patch.mjs <incall-manager clone> [--write [<ref>]]');
  process.exit(2);
}
// The patch is compared byte for byte, so nobody's git config may shape it:
// no global or system config, and every diff setting a repo's own config
// could change is given on the command line.
const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' };
const git = (...args) =>
  execFileSync('git', ['-C', repo, '-c', 'color.ui=never', '-c', 'diff.suppressBlankEmpty=false', ...args], {
    encoding: 'utf8',
    env,
    maxBuffer: 1 << 26
  });

/** The fork's branch: local if there is one, else origin's, else the only remote's. */
function branchHead() {
  const refs = git('for-each-ref', '--format=%(refname)', 'refs/heads/ios-audio-routes', 'refs/remotes/*/ios-audio-routes')
    .split('\n')
    .filter(Boolean);
  const pick =
    refs.find((name) => name === 'refs/heads/ios-audio-routes') ??
    refs.find((name) => name === 'refs/remotes/origin/ios-audio-routes') ??
    (refs.length === 1 ? refs[0] : undefined);
  if (!pick) {
    console.error(
      refs.length === 0
        ? 'no ios-audio-routes branch in the clone (fetch it, or pass the ref after --write)'
        : `several ios-audio-routes branches (${refs.join(', ')}): pass the ref after --write`
    );
    process.exit(2);
  }
  return pick;
}

const recorded = /source-commit: ([0-9a-f]{40})/.exec(readFileSync(readme, 'utf8'))?.[1];
const commit = flag === '--write' ? git('rev-parse', '--verify', `${ref ?? branchHead()}^{commit}`).trim() : recorded;
if (!commit) {
  console.error('docs/patches/README.md records no source-commit');
  process.exit(2);
}
// The patch applies to the released 4.3.0, so it is the change from where the
// fork left the 4.3.0 tag, not from the clone's master, which moves with upstream.
const base = git('merge-base', 'refs/tags/4.3.0', commit).trim();
const prefix = 'node_modules/react-native-incall-manager/';
const diff = git(
  'diff',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-relative',
  '--no-renames',
  '--diff-algorithm=myers',
  '--indent-heuristic',
  '-U3',
  '--inter-hunk-context=0',
  '--abbrev=7',
  `-O${devNull}`,
  `--src-prefix=a/${prefix}`,
  `--dst-prefix=b/${prefix}`,
  base,
  commit,
  '--',
  'index.d.ts',
  'index.js',
  'ios'
);
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
