const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { after, test } = require('node:test');

const withPodDeploymentTarget = require('./withPodDeploymentTarget');
const withReactNativeFromSource = require('./withReactNativeFromSource');
const { count, makeProject, prebuild, removeProjects } = require('./test/prebuild');

after(removeProjects);

const BEGIN = '# @generated begin withReactNativeFromSource -';
const END = '# @generated end withReactNativeFromSource';

const hasRuby = (() => {
  try {
    execFileSync('ruby', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const properties = (root) => JSON.parse(fs.readFileSync(path.join(root, 'ios', 'Podfile.properties.json'), 'utf8'));

test('sets ios.buildReactNativeFromSource, which the template Podfile reads to skip the prebuilt core', async () => {
  const root = makeProject('properties');
  const { podfile } = await prebuild(root, [withReactNativeFromSource]);
  assert.equal(properties(root)['ios.buildReactNativeFromSource'], 'true');
  // The Expo SDK 54 template's switch: prebuilt React Native only when this property is not "true".
  assert.match(podfile, /RCT_USE_PREBUILT_RNCORE'\] \|\|= '1' if podfile_properties\['ios.buildReactNativeFromSource'\] != 'true'/);
});

test('adds one fmt block to post_install, and a second prebuild changes nothing', async () => {
  const root = makeProject('template');
  const one = await prebuild(root, [withReactNativeFromSource]);
  const two = await prebuild(root, [withReactNativeFromSource]);
  assert.equal(count(one.podfile, BEGIN), 1);
  assert.equal(two.podfile, one.podfile);
  const block = one.podfile.slice(one.podfile.indexOf(BEGIN), one.podfile.indexOf(END));
  assert.ok(block.includes("next unless target.name == 'fmt'"));
  assert.ok(block.includes("build.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++17'"));
  assert.ok(one.podfile.indexOf('post_install do |installer|') < one.podfile.indexOf(BEGIN));
});

test('works next to withPodDeploymentTarget, as the example uses them', async () => {
  const root = makeProject('both');
  const one = await prebuild(root, [withPodDeploymentTarget, withReactNativeFromSource]);
  const two = await prebuild(root, [withPodDeploymentTarget, withReactNativeFromSource]);
  assert.equal(count(one.podfile, BEGIN), 1);
  assert.equal(count(one.podfile, '# @generated begin withPodDeploymentTarget -'), 1);
  assert.equal(two.podfile, one.podfile);
});

test('a Podfile without post_install fails with a message that says so', async () => {
  const root = makeProject('no-post-install', {
    Podfile: (podfile) => podfile.replace(/ {2}post_install do \|installer\|[\s\S]*?\n {2}end\n/, '')
  });
  await assert.rejects(prebuild(root, [withReactNativeFromSource]), /withReactNativeFromSource: no `post_install do \|installer\|` block/);
});

test('the block sets C++17 on fmt only (run under Ruby with stub targets)', { skip: !hasRuby && 'ruby is not installed' }, async () => {
  const root = makeProject('ruby-run');
  const { podfile } = await prebuild(root, [withReactNativeFromSource]);
  execFileSync('ruby', ['-c', path.join(root, 'ios', 'Podfile')], { encoding: 'utf8' });
  const block = podfile.slice(podfile.indexOf(BEGIN), podfile.indexOf(END)).split('\n').slice(1).join('\n');
  const script = `
Build = Struct.new(:build_settings)
Target = Struct.new(:name, :build_configurations)
Project = Struct.new(:targets)
Installer = Struct.new(:pods_project)
fmt = Target.new('fmt', [Build.new({ 'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20' })])
folly = Target.new('RCT-Folly', [Build.new({ 'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20' })])
installer = Installer.new(Project.new([fmt, folly]))
${block}
puts fmt.build_configurations[0].build_settings['CLANG_CXX_LANGUAGE_STANDARD']
puts folly.build_configurations[0].build_settings['CLANG_CXX_LANGUAGE_STANDARD']
`;
  const out = execFileSync('ruby', ['-e', script], { encoding: 'utf8' });
  assert.deepEqual(out.trim().split('\n'), ['c++17', 'c++20']);
});
