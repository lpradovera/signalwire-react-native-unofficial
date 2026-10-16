import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
 * every write rewrites the whole file, and only this process may use it.
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

  /** The write in flight, if any. Writes run one after another. */
  private writing: Promise<void> = Promise.resolve();

  /**
   * Writes the current devices to a temporary file and renames it over the
   * real one, one write at a time. Overlapping in-place rewrites used to tear
   * the file (a shorter array followed by the tail of a longer one), and a
   * kill mid-write left it empty; either way the next boot failed to parse it.
   * A rename replaces the file whole, and each queued write snapshots the
   * devices when its turn comes, so the last one on disk is the latest state.
   */
  protected override persist(): Promise<void> {
    const next = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify([...this.devices.values()], null, 2), 'utf8');
      await rename(temporary, this.path);
    });
    // A failed write must not wedge every later one.
    this.writing = next.catch(() => undefined);
    return next;
  }
}
