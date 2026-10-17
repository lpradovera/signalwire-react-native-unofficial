import { promises as fs } from 'node:fs';
import path from 'node:path';

import { IOSConfig, withDangerousMod, withXcodeProject } from 'expo/config-plugins';

import type { ConfigPlugin, XcodeProject } from 'expo/config-plugins';

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
      const projectName = projectConfig.modRequest.projectName;
      if (projectName) {
        addObjcSourceToProject(projectConfig.modResults, projectName, fileName);
      }
      return projectConfig;
    });
  };
}

/**
 * Adds `<projectName>/<fileName>` to the app target's compile sources, in the
 * app's group, with Expo's own helper. Idempotent: prebuild without --clean
 * re-runs mods over an existing project, and a duplicate build-file entry
 * makes Xcode compile the translation unit twice, which fails on duplicate
 * symbols; the helper skips a file the group already lists.
 */
export function addObjcSourceToProject(project: XcodeProject, projectName: string, fileName: string): void {
  IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
    filepath: `${projectName}/${fileName}`,
    groupName: projectName,
    project
  });
}
