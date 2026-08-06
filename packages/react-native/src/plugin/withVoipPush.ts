import { promises as fs } from 'node:fs';
import path from 'node:path';

import { withDangerousMod, withXcodeProject } from '@expo/config-plugins';

import { VOIP_PUSH_SOURCE } from './voipPushSource';

import type { ConfigPlugin } from '@expo/config-plugins';

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
    const project = projectConfig.modResults;
    const projectName = projectConfig.modRequest.projectName;
    if (!projectName) {
      return projectConfig;
    }

    // Idempotent: prebuild without --clean re-runs mods over an existing
    // project, and a duplicate build-file entry makes Xcode compile the
    // translation unit twice, which fails on duplicate symbols.
    const alreadyAdded = Object.values(
      (project.hash?.project?.objects?.PBXBuildFile ?? {}) as Record<string, unknown>
    ).some((entry) => typeof entry === 'object' && JSON.stringify(entry).includes(SOURCE_NAME));

    if (alreadyAdded) {
      return projectConfig;
    }

    const group = project.pbxGroupByName(projectName);
    const groupKey = group
      ? Object.keys(project.hash.project.objects.PBXGroup as Record<string, unknown>).find(
          (key) =>
            (project.hash.project.objects.PBXGroup as Record<string, { name?: string }>)[key]
              ?.name === projectName
        )
      : undefined;

    project.addSourceFile(
      `${projectName}/${SOURCE_NAME}`,
      { target: project.getFirstTarget().uuid },
      groupKey
    );

    return projectConfig;
  });
};
