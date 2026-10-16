const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { after, test } = require('node:test');

const withPodDeploymentTarget = require('./withPodDeploymentTarget');
const { count, makeProject, prebuild, removeProjects } = require('./test/prebuild');

after(removeProjects);

const BEGIN = '# @generated begin withPodDeploymentTarget -';
const END = '# @generated end withPodDeploymentTarget';

const hasRuby = (() => {
  try {
    execFileSync('ruby', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** The lines from `post_install do` through the end of the generated block. */
function postInstall(podfile) {
  const lines = podfile.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes('post_install do |'));
  const end = lines.findIndex((line) => line.includes(END));
  return lines.slice(start, end + 1);
}

test('adds one block, first thing in post_install, and a second prebuild changes nothing', async () => {
  const root = makeProject('template');
  const one = await prebuild(root, [withPodDeploymentTarget]);
  const two = await prebuild(root, [withPodDeploymentTarget]);
  assert.equal(count(one.podfile, BEGIN), 1);
  assert.equal(two.podfile, one.podfile);
  const lines = postInstall(one.podfile);
  assert.match(lines[0], /^ {2}post_install do \|installer\|$/);
  assert.match(lines[1], /^ {4}# @generated begin withPodDeploymentTarget -/);
  assert.ok(lines.some((line) => line.includes('result.resource_bundle_targets.each')));
  // React Native's own call follows the block, untouched.
  const after = one.podfile.slice(one.podfile.indexOf(END));
  assert.match(after, /react_native_post_install\(\n {6}installer,\n/);
});

test('a one-line react_native_post_install call does not move the block or fail', async () => {
  const oneLine = (podfile) =>
    podfile.replace(
      /react_native_post_install\([\s\S]*?\n\s*\)\n/,
      'react_native_post_install(installer, config[:reactNativePath], :mac_catalyst_enabled => false)\n' +
        "    installer.pods_project.targets.each do |target|\n      target.build_configurations.each do |build|\n" +
        "        build.build_settings['OTHER_LDFLAGS'] = flags_for(\n          target.name\n        )\n      end\n    end\n"
    );
  const root = makeProject('one-line', { Podfile: oneLine });
  const { podfile } = await prebuild(root, [withPodDeploymentTarget]);
  const lines = postInstall(podfile);
  assert.match(lines[1], /# @generated begin withPodDeploymentTarget -/);
  // Not inside the later multi-line call.
  const block = podfile.slice(podfile.indexOf(BEGIN), podfile.indexOf(END));
  assert.ok(!block.includes('flags_for'));
  assert.ok(podfile.indexOf(END) < podfile.indexOf('flags_for('));
});

test('a CRLF Podfile gets the block, keeps CRLF, and a second prebuild changes nothing', async () => {
  const root = makeProject('crlf', { Podfile: (podfile) => podfile.replace(/\n/g, '\r\n') });
  const one = await prebuild(root, [withPodDeploymentTarget]);
  const two = await prebuild(root, [withPodDeploymentTarget]);
  assert.equal(count(one.podfile, BEGIN), 1);
  assert.ok(!/[^\r]\n/.test(one.podfile), 'every line ends in CRLF');
  assert.equal(two.podfile, one.podfile);
});

test('a changed block is replaced on the next prebuild without --clean', async () => {
  const root = makeProject('changed');
  const one = await prebuild(root, [withPodDeploymentTarget]);
  const podfilePath = path.join(root, 'ios', 'Podfile');
  // What an older version of the plugin left: same tag, different body and hash.
  fs.writeFileSync(
    podfilePath,
    one.podfile
      .replace(/(# @generated begin withPodDeploymentTarget - .*) sync-[0-9a-f]+/, '$1 sync-0000')
      .replace("app_minimum = (podfile_properties['ios.deploymentTarget'] || '15.1').to_s", "app_minimum = '13.0'")
  );
  const two = await prebuild(root, [withPodDeploymentTarget]);
  assert.equal(two.podfile, one.podfile);
});

test('a post_install that names its block parameter differently gets that name', async () => {
  const root = makeProject('param', {
    Podfile: (podfile) =>
      podfile.replace('post_install do |installer|', 'post_install do |pods|').replace('      installer,\n', '      pods,\n')
  });
  const { podfile } = await prebuild(root, [withPodDeploymentTarget]);
  const block = podfile.slice(podfile.indexOf(BEGIN), podfile.indexOf(END));
  assert.ok(block.includes('pods.target_installation_results'));
  assert.ok(!block.includes('installer'));
});

test('a Podfile without post_install fails with a message that says so', async () => {
  const root = makeProject('no-post-install', {
    Podfile: (podfile) => podfile.replace(/ {2}post_install do \|installer\|[\s\S]*?\n {2}end\n/, '')
  });
  await assert.rejects(prebuild(root, [withPodDeploymentTarget]), /withPodDeploymentTarget: no `post_install do \|installer\|` block/);
});

test('the generated Podfile is valid Ruby', { skip: !hasRuby && 'ruby is not installed' }, async () => {
  const root = makeProject('ruby');
  await prebuild(root, [withPodDeploymentTarget]);
  const out = execFileSync('ruby', ['-c', path.join(root, 'ios', 'Podfile')], { encoding: 'utf8' });
  assert.match(out, /Syntax OK/);
});

test('the block raises only resource bundles below the minimum (run under Ruby with stub targets)', { skip: !hasRuby && 'ruby is not installed' }, async () => {
  const root = makeProject('ruby-run');
  const { podfile } = await prebuild(root, [withPodDeploymentTarget]);
  const block = podfile
    .slice(podfile.indexOf(BEGIN), podfile.indexOf(END))
    .split('\n')
    .slice(1)
    .join('\n');
  const script = `
Build = Struct.new(:build_settings)
Bundle = Struct.new(:build_configurations)
Result = Struct.new(:resource_bundle_targets)
Results = Struct.new(:pod_target_installation_results)
Installer = Struct.new(:target_installation_results)
old_bundle = Bundle.new([Build.new({ 'IPHONEOS_DEPLOYMENT_TARGET' => '9.0' })])
new_bundle = Bundle.new([Build.new({ 'IPHONEOS_DEPLOYMENT_TARGET' => '17.0' })])
installer = Installer.new(Results.new({ 'A' => Result.new([old_bundle, new_bundle]) }))
podfile_properties = { 'ios.deploymentTarget' => '15.1' }
${block}
puts old_bundle.build_configurations[0].build_settings['IPHONEOS_DEPLOYMENT_TARGET']
puts new_bundle.build_configurations[0].build_settings['IPHONEOS_DEPLOYMENT_TARGET']
`;
  const out = execFileSync('ruby', ['-e', script], { encoding: 'utf8' });
  assert.deepEqual(out.trim().split('\n'), ['15.1', '17.0']);
});
