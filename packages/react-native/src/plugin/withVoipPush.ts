import { promises as fs } from 'node:fs';
import path from 'node:path';

import { IOSConfig, withDangerousMod, withXcodeProject } from '@expo/config-plugins';

import { VOIP_PUSH_SOURCE } from './voipPushSource';

import type { ConfigPlugin, XcodeProject } from '@expo/config-plugins';

const SOURCE_NAME = 'SignalWireVoipPush.m';

/**
 * Injects the native VoIP push hook.
 *
 * Two mods, because writing the file is not enough — Xcode only compiles what
 * the project file lists, so an unreferenced `.m` is silently ignored and the
 * failure appears much later as "pushes do nothing".
 *
 * 1. `withDangerousMod` writes the source next to the generated `AppDelegate`.
 * 2. `withXcodeProject` adds it to the target's compile sources.
 *
 * Only applied when `enableVoipPush` is on: an app without a VoIP entitlement
 * that registers a `PKPushRegistry` is asking iOS for a capability it does not
 * have.
 */
export const withVoipPush: ConfigPlugin = (config) => {
  const withSource = withDangerousMod(config, [
    'ios',
    async (modConfig) => {
      const projectRoot = modConfig.modRequest.platformProjectRoot;
      const projectName = modConfig.modRequest.projectName;
      if (!projectName) {
        throw new Error(
          '@signalwire/react-native: cannot inject the VoIP push hook without an iOS project name. ' +
            'Run `expo prebuild` from a project with an ios.bundleIdentifier configured.'
        );
      }

      const target = path.join(projectRoot, projectName, SOURCE_NAME);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, VOIP_PUSH_SOURCE, 'utf8');

      return modConfig;
    }
  ]);

  return withXcodeProject(withSource, (projectConfig) => {
    const projectName = projectConfig.modRequest.projectName;
    if (projectName) {
      addVoipSourceToProject(projectConfig.modResults, projectName);
    }
    return projectConfig;
  });
};

/**
 * Adds the hook to the app target's compile sources, in the app's group.
 *
 * Idempotent: prebuild without --clean re-runs mods over an existing project,
 * and a duplicate build-file entry makes Xcode compile the translation unit
 * twice, which fails on duplicate symbols. Expo's helper skips a file the
 * group already lists.
 */
export function addVoipSourceToProject(project: XcodeProject, projectName: string): void {
  IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
    filepath: `${projectName}/${SOURCE_NAME}`,
    groupName: projectName,
    project
  });
}
