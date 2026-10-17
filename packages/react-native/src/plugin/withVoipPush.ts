import { VOIP_PUSH_SOURCE } from './voipPushSource';
import { addObjcSourceToProject, withObjcSource } from './withObjcSource';

import type { ConfigPlugin, XcodeProject } from 'expo/config-plugins';

const SOURCE_NAME = 'SignalWireVoipPush.m';

/**
 * Injects the native VoIP push hook (`SignalWireVoipPush.m`).
 *
 * Only applied when `enableVoipPush` is on: an app without a VoIP entitlement
 * that registers a `PKPushRegistry` is asking iOS for a capability it does not
 * have.
 */
export const withVoipPush: ConfigPlugin = withObjcSource(SOURCE_NAME, VOIP_PUSH_SOURCE, 'the VoIP push hook');

/**
 * Adds the hook to the app target's compile sources, in the app's group, once
 * (see {@link addObjcSourceToProject}).
 */
export function addVoipSourceToProject(project: XcodeProject, projectName: string): void {
  addObjcSourceToProject(project, projectName, SOURCE_NAME);
}
