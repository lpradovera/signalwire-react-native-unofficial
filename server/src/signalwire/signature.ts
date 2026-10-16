import { createHmac, timingSafeEqual } from 'node:crypto';

import type { IncomingHttpHeaders } from 'node:http';
import type { NextFunction, Request, Response } from 'express';

/**
 * SignalWire request signatures, for the routes SignalWire itself calls.
 *
 * SignalWire signs the JSON webhooks it sends (SWML handler fetches, RELAY and
 * status callbacks) with the Signing Key from the space's API credentials:
 *
 *   X-SignalWire-Sha256-Signature: hex(HMAC-SHA256(key, url + rawBody))
 *   X-SignalWire-Signature:        hex(HMAC-SHA1(key, url + rawBody))
 *
 * `url` is the full URL SignalWire requested, query string included, and
 * `rawBody` the body exactly as it arrived. This is the scheme SignalWire's
 * own server SDKs validate (signalwire-typescript `WebhookValidator`,
 * signalwire-python `webhook_validator`); the tests use the vectors from
 * their documentation. The form-encoded cXML variant is not implemented: no
 * route here receives form posts.
 *
 * A signature has no timestamp, so it does not stop a captured request being
 * replayed. The routes it guards are idempotent or single-use on their own.
 */

export const SHA256_HEADER = 'x-signalwire-sha256-signature';
export const SHA1_HEADER = 'x-signalwire-signature';

function hmacHex(algorithm: 'sha1' | 'sha256', key: string, message: string): string {
  return createHmac(algorithm, key).update(message, 'utf8').digest('hex');
}

function safeEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function isSignedBySignalWire({
  signingKey,
  url,
  rawBody,
  headers
}: {
  signingKey: string;
  url: string;
  rawBody: string;
  headers: IncomingHttpHeaders;
}): boolean {
  const message = url + rawBody;

  const sha256 = header(headers, SHA256_HEADER);
  if (sha256 && safeEqual(hmacHex('sha256', signingKey, message), sha256)) {
    return true;
  }
  const sha1 = header(headers, SHA1_HEADER);
  return Boolean(sha1 && safeEqual(hmacHex('sha1', signingKey, message), sha1));
}

const RAW_BODY = Symbol('rawBody');

type WithRawBody = Request & { [RAW_BODY]?: string };

/**
 * `verify` hook for `express.json`: keeps the body as it arrived, because the
 * signature covers those bytes and re-serialising the parsed JSON would not
 * reproduce them.
 */
export function captureRawBody(req: unknown, _res: unknown, buffer: Buffer): void {
  (req as WithRawBody)[RAW_BODY] = buffer.toString('utf8');
}

/**
 * Rejects a request SignalWire did not sign.
 *
 * `publicUrl` is the base SignalWire calls (the tunnel), because the URL this
 * process sees behind it — http, a local port — is not the one that was
 * signed. Forwarded headers are not consulted: they are easy to forge.
 */
export function requireSignalWireSignature({
  signingKey,
  publicUrl
}: {
  signingKey: string;
  publicUrl: string;
}) {
  const base = publicUrl.replace(/\/$/, '');
  return (req: Request, res: Response, next: NextFunction): void => {
    const url = `${base}${req.originalUrl}`;
    const rawBody = (req as WithRawBody)[RAW_BODY] ?? '';
    if (isSignedBySignalWire({ signingKey, url, rawBody, headers: req.headers })) {
      next();
      return;
    }
    console.warn(
      JSON.stringify({
        at: new Date().toISOString(),
        message: 'Rejected unsigned or mis-signed SignalWire request',
        path: req.path,
        url,
        hasSignature: Boolean(req.headers[SHA256_HEADER] ?? req.headers[SHA1_HEADER])
      })
    );
    res.status(403).json({ error: 'Invalid SignalWire signature' });
  };
}
