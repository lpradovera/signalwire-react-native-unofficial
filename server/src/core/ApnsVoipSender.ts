import http2 from 'node:http2';

import { signApnsToken } from './jwt.js';
import { TokenExpiredError } from './types.js';

import type { Device, PushPayload, PushSender } from './types.js';

const PRODUCTION_HOST = 'https://api.push.apple.com';
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';

/** Apple rejects provider tokens older than 1h, and regeneration under 20 min. */
const TOKEN_TTL_MS = 30 * 60 * 1000;

export interface ApnsConfig {
  teamId: string;
  keyId: string;
  /** Contents of the .p8 file, including the BEGIN/END lines. */
  privateKey: string;
  /** Your app's bundle id, *without* the `.voip` suffix — this adds it. */
  bundleId: string;
}

/**
 * Sends iOS VoIP pushes through PushKit.
 *
 * Three things silently break a VoIP push, all handled here:
 * - `apns-topic` must carry the `.voip` suffix; the plain bundle id is rejected.
 * - `apns-push-type: voip` is mandatory.
 * - Sandbox and production tokens are not interchangeable, so the host is
 *   chosen per-device from `device.environment`.
 */
export class ApnsVoipSender implements PushSender {
  readonly platform = 'ios' as const;

  private cachedToken: string | null = null;
  private cachedAt = 0;

  constructor(private readonly config: ApnsConfig) {}

  private bearer(): string {
    const now = Date.now();
    if (this.cachedToken && now - this.cachedAt < TOKEN_TTL_MS) {
      return this.cachedToken;
    }
    this.cachedToken = signApnsToken({
      teamId: this.config.teamId,
      keyId: this.config.keyId,
      privateKey: this.config.privateKey
    });
    this.cachedAt = now;
    return this.cachedToken;
  }

  async send(device: Device, payload: PushPayload): Promise<void> {
    const host = device.environment === 'sandbox' ? SANDBOX_HOST : PRODUCTION_HOST;
    const client = http2.connect(host);
    const body = JSON.stringify(payload);

    try {
      const request = client.request({
        ':method': 'POST',
        ':path': `/3/device/${device.token}`,
        authorization: `bearer ${this.bearer()}`,
        'apns-topic': `${this.config.bundleId}.voip`,
        'apns-push-type': 'voip',
        'apns-priority': '10',
        // Deliver now or discard. A late call notification is worse than none.
        'apns-expiration': '0',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      });

      request.setTimeout(10_000, () => request.destroy(new Error('APNs request timed out')));
      request.end(body);

      await new Promise<void>((resolve, reject) => {
        let status = 0;
        let data = '';

        request.on('response', (headers) => {
          status = Number(headers[':status'] ?? 0);
        });
        request.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        request.on('end', () => {
          if (status === 200) {
            resolve();
            return;
          }
          // 410 Gone, or 400 BadDeviceToken — the device is no longer reachable
          // and the token should be pruned rather than retried.
          if (status === 410 || data.includes('BadDeviceToken') || data.includes('Unregistered')) {
            reject(new TokenExpiredError(device.token));
            return;
          }
          reject(new Error(`APNs ${status}: ${data || '(no body)'}`));
        });
        request.on('error', reject);
      });
    } finally {
      client.close();
    }
  }
}
