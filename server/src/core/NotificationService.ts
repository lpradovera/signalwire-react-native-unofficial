import { randomUUID } from 'node:crypto';

import { TokenExpiredError } from './types.js';

import type { DeviceStore } from './DeviceStore.js';
import type {
  CallNotification,
  DeliveryResult,
  Device,
  NotifyResult,
  Platform,
  PushSender
} from './types.js';

export interface NotificationServiceOptions {
  store: DeviceStore;
  senders: readonly PushSender[];
  /** Injected for tests. */
  uuid?: () => string;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Fans a call notification out to every device a user has registered.
 *
 * Deliberately generic — it has no idea SignalWire exists. Delivery is
 * best-effort and parallel: the first device to answer wins, and the registry
 * on the other devices ends their native call entries as missed.
 */
export class NotificationService {
  private readonly store: DeviceStore;
  private readonly senders: Map<Platform, PushSender>;
  private readonly uuid: () => string;
  private readonly log: (message: string, meta?: Record<string, unknown>) => void;

  constructor(options: NotificationServiceOptions) {
    this.store = options.store;
    this.senders = new Map(options.senders.map((sender) => [sender.platform, sender]));
    this.uuid = options.uuid ?? randomUUID;
    this.log = options.log ?? (() => undefined);
  }

  async notify(notification: CallNotification): Promise<NotifyResult> {
    const devices = await this.store.findByUser(notification.externalUserId);

    if (devices.length === 0) {
      this.log('No devices registered', { externalUserId: notification.externalUserId });
      return {
        correlationId: notification.correlationId,
        attempted: 0,
        delivered: 0,
        pruned: 0,
        results: []
      };
    }

    const results = await Promise.all(
      devices.map((device) => this.deliver(device, notification))
    );

    const expired = results.filter((result) => result.status === 'token-expired');
    // Pruned after the fan-out so a dead token never blocks a live one.
    await Promise.all(expired.map((result) => this.store.remove(result.token)));

    const outcome: NotifyResult = {
      correlationId: notification.correlationId,
      attempted: results.length,
      delivered: results.filter((result) => result.status === 'delivered').length,
      pruned: expired.length,
      results
    };

    this.log('Notified', {
      correlationId: outcome.correlationId,
      attempted: outcome.attempted,
      delivered: outcome.delivered,
      pruned: outcome.pruned
    });

    return outcome;
  }

  private async deliver(
    device: Device,
    notification: CallNotification
  ): Promise<DeliveryResult> {
    const sender = this.senders.get(device.platform);

    if (!sender) {
      return {
        token: device.token,
        platform: device.platform,
        status: 'failed',
        error: `No sender configured for platform "${device.platform}"`
      };
    }

    try {
      await sender.send(device, {
        call_id: notification.correlationId,
        from: notification.from ?? 'Unknown',
        from_name: notification.fromName ?? 'Unknown caller',
        // iOS only: generated here so the AppDelegate hook and the JS side
        // agree on one identifier for the CallKit entry.
        ...(device.platform === 'ios' ? { uuid: this.uuid() } : {}),
        // Opaque extras last: a bridge token rides here, and nothing above
        // should be silently overwritten by it.
        ...(notification.data ?? {})
      });

      return { token: device.token, platform: device.platform, status: 'delivered' };
    } catch (error) {
      if (error instanceof TokenExpiredError) {
        return { token: device.token, platform: device.platform, status: 'token-expired' };
      }
      return {
        token: device.token,
        platform: device.platform,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
