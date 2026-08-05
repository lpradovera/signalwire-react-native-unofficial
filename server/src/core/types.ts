/**
 * Generic core types. Nothing here knows what SignalWire is — that keeps this
 * half extractable as a standalone push service. The SignalWire-specific
 * mapping lives in `src/signalwire/`.
 */

export type Platform = 'ios' | 'android';

/** iOS only. Sandbox and production tokens are never interchangeable. */
export type ApnsEnvironment = 'sandbox' | 'production';

export interface Device {
  /**
   * Opaque id of the user this device belongs to. Deliberately *not* named
   * `subscriberId` — the core must not encode a SignalWire concept.
   */
  readonly externalUserId: string;
  readonly platform: Platform;
  /** PushKit token on iOS, FCM registration token on Android. */
  readonly token: string;
  readonly environment: ApnsEnvironment;
  readonly updatedAt: number;
}

export type DeviceRegistration = Omit<Device, 'updatedAt'>;

/**
 * A call to announce. `correlationId` is the id both sides must agree on: the
 * client passes it to `reportIncomingPush({ callId })` and the registry fuses
 * on it. For SignalWire that is the call id.
 */
export interface CallNotification {
  readonly externalUserId: string;
  readonly correlationId: string;
  readonly from?: string;
  readonly fromName?: string;
  /** Whether the native UI should offer video. Defaults to false. */
  readonly hasVideo?: boolean;
}

export type DeliveryStatus = 'delivered' | 'token-expired' | 'failed';

export interface DeliveryResult {
  readonly token: string;
  readonly platform: Platform;
  readonly status: DeliveryStatus;
  readonly error?: string;
}

export interface NotifyResult {
  readonly correlationId: string;
  readonly attempted: number;
  readonly delivered: number;
  readonly pruned: number;
  readonly results: readonly DeliveryResult[];
}

/** The payload the device receives. Keep under 4 KB — an APNs hard limit. */
export interface PushPayload {
  readonly call_id: string;
  readonly from: string;
  readonly from_name: string;
  /** iOS only: generated server-side so AppDelegate and JS agree on one id. */
  readonly uuid?: string;
}

/**
 * Thrown by a sender when the provider reports the token is dead. The service
 * prunes on this rather than on a string match, so provider-specific error
 * shapes stay inside the sender.
 */
export class TokenExpiredError extends Error {
  constructor(public readonly token: string) {
    super(`Push token is no longer registered: ${token.slice(0, 12)}…`);
    this.name = 'TokenExpiredError';
  }
}

export interface PushSender {
  readonly platform: Platform;
  send(device: Device, payload: PushPayload): Promise<void>;
}
