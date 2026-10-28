import { NativeModules, Platform } from 'react-native';

import { logger } from '@signalwire/react';

/**
 * Siri's permission for this app, as `INPreferences` reports it, or
 * `'unavailable'`: not iOS, a build without this package's native module, or
 * a build without Siri configured (the config plugin's `enableSiri`, which
 * adds `NSSiriUsageDescription` and the `com.apple.developer.siri`
 * entitlement).
 */
export type SiriAuthorization = 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'unavailable';

/** A call that connected and has ended, as Siri is told about it. */
export interface CompletedCall {
  /** The address the call was placed to or came from: what a call-back dials. */
  handle: string;
  /** The remote party's name, what the user says to Siri. */
  displayName?: string;
  outgoing: boolean;
  video: boolean;
  /** When the call connected and ended, in ms since the epoch. */
  startedAt: number;
  endedAt: number;
}

/** This package's iOS module (ios/SWSiriCalls.m). */
interface SWSiriCallsModule {
  donateCall: (call: {
    handle: string;
    displayName: string;
    outgoing: boolean;
    video: boolean;
    startedAt: number;
    endedAt: number;
  }) => Promise<boolean>;
  authorizationStatus: () => Promise<string>;
  requestAuthorization: () => Promise<string>;
  forgetCalls: () => Promise<boolean>;
}

const STATUSES = new Set<string>(['authorized', 'denied', 'restricted', 'notDetermined', 'unavailable']);

function siriModule(): SWSiriCallsModule | null {
  if (Platform.OS !== 'ios') {
    return null;
  }
  const module = (NativeModules as Record<string, unknown> | undefined)?.SWSiriCalls as
    | Partial<SWSiriCallsModule>
    | null
    | undefined;
  if (
    typeof module?.donateCall !== 'function' ||
    typeof module.authorizationStatus !== 'function' ||
    typeof module.requestAuthorization !== 'function' ||
    typeof module.forgetCalls !== 'function'
  ) {
    return null;
  }
  return module as SWSiriCallsModule;
}

function toAuthorization(status: unknown): SiriAuthorization {
  return typeof status === 'string' && STATUSES.has(status) ? (status as SiriAuthorization) : 'unavailable';
}

/**
 * Handles that name no one to call back: what a push without a `from` is
 * shown as, or nothing at all.
 */
const UNDIALLABLE = new Set(['', 'unknown']);

/**
 * Tells Siri about a call that connected and ended (iOS; a no-op elsewhere).
 *
 * The native module donates an `INInteraction` with an `INStartCallIntent`
 * whose contact is the remote party (`INPerson`: the display name, and the
 * handle as an `INPersonHandle` of unknown type), and keeps the party in the
 * app's list of recent callees. The generated intent handler
 * (`SignalWireSiriCallIntent.m`, the config plugin's `enableSiri`) resolves
 * "call <name> with <app>" against that list, so a name becomes callable
 * after the first call with it. Without the native module (an app not rebuilt
 * since it was added) nothing happens.
 *
 * Resolves `true` when the system took the donation. Never rejects: a call
 * that cannot be donated is logged and otherwise ignored.
 */
export async function donateCompletedCall(call: CompletedCall): Promise<boolean> {
  const module = siriModule();
  const handle = call.handle.trim();
  if (!module || UNDIALLABLE.has(handle.toLowerCase())) {
    return false;
  }
  const displayName = call.displayName?.trim() || handle;
  try {
    const donated = await module.donateCall({
      handle,
      displayName,
      outgoing: call.outgoing,
      video: call.video,
      startedAt: call.startedAt,
      endedAt: call.endedAt
    });
    logger.debug(`Siri donation for ${handle} (${displayName}): ${donated ? 'donated' : 'not donated'}`);
    return donated === true;
  } catch (error) {
    logger.warn(`Siri donation for ${handle} failed:`, error);
    return false;
  }
}

/** Siri's permission for this app; see {@link SiriAuthorization}. */
export async function getSiriAuthorization(): Promise<SiriAuthorization> {
  const module = siriModule();
  if (!module) {
    return 'unavailable';
  }
  try {
    return toAuthorization(await module.authorizationStatus());
  } catch (error) {
    logger.warn('Reading the Siri authorization failed:', error);
    return 'unavailable';
  }
}

/**
 * Asks the user to let the app use Siri (iOS shows its prompt once, with the
 * app's `NSSiriUsageDescription`). Siri hands the app "call <name> with
 * <app>" only once it is `'authorized'`. Resolves `'unavailable'`, without
 * asking, in a build without Siri configured: iOS terminates an app that
 * asks without `NSSiriUsageDescription`.
 */
export async function requestSiriAuthorization(): Promise<SiriAuthorization> {
  const module = siriModule();
  if (!module) {
    return 'unavailable';
  }
  try {
    return toAuthorization(await module.requestAuthorization());
  } catch (error) {
    logger.warn('Requesting Siri authorization failed:', error);
    return 'unavailable';
  }
}

/**
 * Deletes every call this app donated to Siri and its list of recent callees,
 * for a sign-out, say. Siri then no longer resolves those names for the app.
 */
export async function forgetSiriCalls(): Promise<void> {
  const module = siriModule();
  if (!module) {
    return;
  }
  try {
    await module.forgetCalls();
  } catch (error) {
    logger.warn('Deleting the Siri call donations failed:', error);
  }
}
