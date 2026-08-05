import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Device, DeviceRegistration } from './types.js';

/**
 * Where devices live.
 *
 * This interface is the main extraction seam: swap the implementation for
 * Postgres or DynamoDB without touching routes or senders.
 */
export interface DeviceStore {
  register(registration: DeviceRegistration): Promise<Device>;
  remove(token: string): Promise<boolean>;
  findByUser(externalUserId: string): Promise<Device[]>;
  all(): Promise<Device[]>;
}

/** Tokens are globally unique, so they are the primary key. */
export class InMemoryDeviceStore implements DeviceStore {
  protected readonly devices = new Map<string, Device>();

  async register(registration: DeviceRegistration): Promise<Device> {
    const device: Device = { ...registration, updatedAt: Date.now() };
    // A token can migrate between users — reinstall, or a shared handset.
    // Overwriting keeps the newest owner and avoids pushing a call to the
    // person who used the device last.
    this.devices.set(device.token, device);
    await this.persist();
    return device;
  }

  async remove(token: string): Promise<boolean> {
    const existed = this.devices.delete(token);
    if (existed) {
      await this.persist();
    }
    return existed;
  }

  async findByUser(externalUserId: string): Promise<Device[]> {
    return [...this.devices.values()].filter(
      (device) => device.externalUserId === externalUserId
    );
  }

  async all(): Promise<Device[]> {
    return [...this.devices.values()];
  }

  /** Hook for subclasses. */
  protected async persist(): Promise<void> {
    // no-op
  }
}

/**
 * In-memory with a JSON file behind it, so a restart during development does
 * not lose the tokens you just registered from a device. Not for production —
 * every write rewrites the file and there is no locking.
 */
export class JsonFileDeviceStore extends InMemoryDeviceStore {
  private constructor(private readonly path: string) {
    super();
  }

  static async open(path: string): Promise<JsonFileDeviceStore> {
    const store = new JsonFileDeviceStore(path);
    try {
      const raw = await readFile(path, 'utf8');
      for (const device of JSON.parse(raw) as Device[]) {
        store.devices.set(device.token, device);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    return store;
  }

  protected override async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify([...this.devices.values()], null, 2), 'utf8');
  }
}
