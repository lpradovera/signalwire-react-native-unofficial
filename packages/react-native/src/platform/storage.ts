import { logger } from '@signalwire/react';

import type { Storage } from '@signalwire/js';

/**
 * The SDK exports `Storage` but not `StorageScope`, so redeclare it.
 * Must stay identical to `dependencies/interfaces.ts` in the SDK.
 */
export type StorageScope = 'local' | 'session';

/** The subset of AsyncStorage this adapter uses. */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
  multiRemove(keys: readonly string[]): Promise<void>;
}

const NAMESPACE = 'sw-rn';

const prefixFor = (scope: StorageScope): string => `${NAMESPACE}:${scope}:`;
const keyFor = (key: string, scope: StorageScope): string => `${prefixFor(scope)}${key}`;

/**
 * The session scope: in memory, for the life of the process.
 *
 * React Native has no session scope; an app cold start is the equivalent of
 * opening a new browser tab. A process-lifetime map gives the SDK exactly
 * that, and keeps what it stores there off the disk: its bearer secrets (the
 * cached SAT, the session-resume `authorization_state`) are session-scoped,
 * and in AsyncStorage they sat in plaintext in the app sandbox, and in Android
 * Auto Backup, until the next launch purged them. Shared by every adapter in
 * the process, as `sessionStorage` is by every script in a tab.
 */
const sessionValues = new Map<string, string>();

/**
 * Guards the once-per-process purge of session keys an earlier version of
 * this adapter wrote to AsyncStorage.
 */
let sessionPurge: Promise<void> | null = null;

/** Test seam — clears the session scope and the once-per-process purge guard. */
export function resetSessionPurgeForTesting(): void {
  sessionPurge = null;
  sessionValues.clear();
}

async function purgeScope(backing: AsyncStorageLike, scope: StorageScope): Promise<void> {
  const prefix = prefixFor(scope);
  const keys = await backing.getAllKeys();
  const matching = keys.filter((key) => key.startsWith(prefix));
  if (matching.length > 0) {
    await backing.multiRemove(matching);
  }
}

/** SDK `Storage` backed by AsyncStorage, with an in-memory session scope. */
export class ReactNativeStorage implements Storage {
  constructor(private readonly backing: AsyncStorageLike) {
    sessionPurge ??= purgeScope(backing, 'session').catch((error: unknown) => {
      logger.warn('Failed to purge session-scoped storage:', error);
    });
  }

  private async ready(): Promise<void> {
    await sessionPurge;
  }

  async setItem(key: string, value: string | null, scope: StorageScope = 'session'): Promise<void> {
    await this.ready();
    if (scope === 'session') {
      if (value === null) {
        sessionValues.delete(key);
      } else {
        sessionValues.set(key, value);
      }
      return;
    }
    try {
      if (value === null) {
        await this.backing.removeItem(keyFor(key, scope));
        return;
      }
      await this.backing.setItem(keyFor(key, scope), value);
    } catch (error) {
      logger.warn(`Failed to write "${key}" (${scope}):`, error);
    }
  }

  async getItem(key: string, scope: StorageScope = 'session'): Promise<string | null> {
    await this.ready();
    if (scope === 'session') {
      return sessionValues.get(key) ?? null;
    }
    try {
      return await this.backing.getItem(keyFor(key, scope));
    } catch (error) {
      logger.warn(`Failed to read "${key}" (${scope}):`, error);
      return null;
    }
  }

  async removeItem(key: string, scope: StorageScope = 'session'): Promise<void> {
    await this.ready();
    if (scope === 'session') {
      sessionValues.delete(key);
      return;
    }
    try {
      await this.backing.removeItem(keyFor(key, scope));
    } catch (error) {
      logger.warn(`Failed to remove "${key}" (${scope}):`, error);
    }
  }

  async clear(scope: StorageScope = 'session'): Promise<void> {
    await this.ready();
    if (scope === 'session') {
      sessionValues.clear();
      return;
    }
    try {
      await purgeScope(this.backing, scope);
    } catch (error) {
      logger.warn(`Failed to clear scope "${scope}":`, error);
    }
  }
}
