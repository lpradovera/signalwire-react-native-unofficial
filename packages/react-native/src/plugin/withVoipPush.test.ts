import path from 'node:path';

import { IOSConfig } from '@expo/config-plugins';

import { addVoipSourceToProject } from './withVoipPush';

// Jest provides it; the package's types leave Node globals out on purpose.
declare const __dirname: string;

// The Expo SDK 54 bare template's project (expo-template-bare-minimum 54.0.53).
const FIXTURE = path.join(__dirname, '__fixtures__');

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('addVoipSourceToProject', () => {
  it('adds the hook to the app target once, in the app group', () => {
    const project = IOSConfig.XcodeUtils.getPbxproj(FIXTURE);
    addVoipSourceToProject(project, 'HelloWorld');
    const written = project.writeSync();

    // One PBXBuildFile and one Sources-phase entry.
    expect(count(written, 'SignalWireVoipPush.m in Sources')).toBe(2);
    expect(written).toMatch(/path = "?HelloWorld\/SignalWireVoipPush\.m"?;/);
    const group = project.pbxGroupByName('HelloWorld') as { children: Array<{ comment: string }> };
    expect(group.children.map((child) => child.comment)).toContain('SignalWireVoipPush.m');
    const app = project.getTarget('com.apple.product-type.application');
    const sources = project.pbxSourcesBuildPhaseObj(app.uuid) as { files: Array<{ comment: string }> };
    expect(sources.files.map((file) => file.comment)).toContain('SignalWireVoipPush.m in Sources');
  });

  it('changes nothing when prebuild re-runs over a project that has it', () => {
    // A second build-file entry compiles the translation unit twice, which
    // fails on duplicate symbols.
    const project = IOSConfig.XcodeUtils.getPbxproj(FIXTURE);
    addVoipSourceToProject(project, 'HelloWorld');
    const once = project.writeSync();
    addVoipSourceToProject(project, 'HelloWorld');

    expect(project.writeSync()).toBe(once);
  });
});
