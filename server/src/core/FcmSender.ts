import { signGoogleAssertion } from './jwt.js';
import { TokenExpiredError } from './types.js';

import type { Device, PushPayload, PushSender } from './types.js';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ACCESS_TOKEN_TTL_MS = 50 * 60 * 1000;

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  /** `private_key` from the service-account JSON, newlines intact. */
  privateKey: string;
}

/**
 * Sends Android call notifications as high-priority FCM **data** messages.
 *
 * Two rules this depends on:
 * - The message must be data-only. Adding a `notification` block hands it to
 *   the system tray and the app's background handler never runs.
 * - `android.priority: 'high'` is what lets it pierce Doze.
 */
export class FcmSender implements PushSender {
  readonly platform = 'android' as const;

  private accessToken: string | null = null;
  private fetchedAt = 0;

  constructor(
    private readonly config: FcmConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async bearer(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now - this.fetchedAt < ACCESS_TOKEN_TTL_MS) {
      return this.accessToken;
    }

    const assertion = signGoogleAssertion({
      clientEmail: this.config.clientEmail,
      privateKey: this.config.privateKey,
      scope: SCOPE
    });

    const response = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion
      })
    });

    if (!response.ok) {
      throw new Error(`Google OAuth ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as { access_token: string };
    this.accessToken = body.access_token;
    this.fetchedAt = now;
    return this.accessToken;
  }

  async send(device: Device, payload: PushPayload): Promise<void> {
    const token = await this.bearer();

    const response = await this.fetchImpl(
      `https://fcm.googleapis.com/v1/projects/${this.config.projectId}/messages:send`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: device.token,
            data: {
              call_id: payload.call_id,
              from: payload.from,
              from_name: payload.from_name
            },
            android: { priority: 'high' }
          }
        })
      }
    );

    if (response.ok) {
      return;
    }

    const text = await response.text();
    if (response.status === 404 || text.includes('UNREGISTERED') || text.includes('NOT_FOUND')) {
      throw new TokenExpiredError(device.token);
    }
    throw new Error(`FCM ${response.status}: ${text}`);
  }
}
