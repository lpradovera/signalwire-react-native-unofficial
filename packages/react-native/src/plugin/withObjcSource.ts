import { promises as fs } from 'node:fs';
import path from 'node:path';

import { withDangerousMod, withXcodeProject } from 'expo/config-plugins';

import type { ConfigPlugin } from 'expo/config-plugins';

/**
 * Writes a generated Objective-C file next to the AppDelegate and adds it to
 * the app target's compile sources.
 *
 * Two mods, because writing the file is not enough: Xcode only compiles what
 * the project file lists, so an unreferenced `.m` is silently ignored.
 * Idempotent: prebuild without --clean re-runs mods over an existing project,
 * and a duplicate build-file entry fails the build on duplicate symbols.
 */
export function withObjcSource(fileName: string, source: string, purpose: string): ConfigPlugin {
  return (config) => {
    const withSource = withDangerousMod(config, [
      'ios',
      async (modConfig) => {
        const projectRoot = modConfig.modRequest.platformProjectRoot;
        const projectName = modConfig.modRequest.projectName;
        if (!projectName) {
          throw new Error(
            `@signalwire/react-native: cannot inject ${purpose} without an iOS project name. ` +
              'Run `expo prebuild` from a project with an ios.bundleIdentifier configured.'
          );
        }

        const target = path.join(projectRoot, projectName, fileName);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, source, 'utf8');

        return modConfig;
      }
    ]);

    return withXcodeProject(withSource, (projectConfig) => {
      const project = projectConfig.modResults;
      const projectName = projectConfig.modRequest.projectName;
      if (!projectName) {
        return projectConfig;
      }

      const alreadyAdded = Object.values(
        (project.hash?.project?.objects?.PBXBuildFile ?? {}) as Record<string, unknown>
      ).some((entry) => typeof entry === 'object' && JSON.stringify(entry).includes(fileName));

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

      project.addSourceFile(`${projectName}/${fileName}`, { target: project.getFirstTarget().uuid }, groupKey);

      return projectConfig;
    });
  };
}
