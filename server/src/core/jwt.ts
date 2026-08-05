import { createSign } from 'node:crypto';

/**
 * Minimal JWT signing for the two provider handshakes.
 *
 * Hand-rolled on `node:crypto` rather than pulling in `jsonwebtoken` and
 * `googleapis`: it is about thirty lines, and it keeps this scaffold's runtime
 * dependency list down to Express alone.
 */

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64url');

function sign(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  privateKey: string,
  algorithm: 'sha256',
  dsaEncoding?: 'ieee-p1363'
): string {
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign(algorithm);
  signer.update(signingInput);
  signer.end();

  const signature = signer.sign(
    dsaEncoding ? { key: privateKey, dsaEncoding } : privateKey
  );

  return `${signingInput}.${signature.toString('base64url')}`;
}

/**
 * APNs provider token (ES256).
 *
 * Apple rejects tokens older than one hour and refuses regeneration more than
 * once every twenty minutes, so callers must cache — see {@link ApnsVoipSender}.
 *
 * `dsaEncoding: 'ieee-p1363'` is required: Node defaults to DER, which Apple
 * rejects with a 403 that says nothing useful.
 */
export function signApnsToken(options: {
  teamId: string;
  keyId: string;
  privateKey: string;
  issuedAt?: number;
}): string {
  const iat = options.issuedAt ?? Math.floor(Date.now() / 1000);
  return sign(
    { alg: 'ES256', kid: options.keyId, typ: 'JWT' },
    { iss: options.teamId, iat },
    options.privateKey,
    'sha256',
    'ieee-p1363'
  );
}

/** Google service-account assertion (RS256), exchanged for an OAuth2 token. */
export function signGoogleAssertion(options: {
  clientEmail: string;
  privateKey: string;
  scope: string;
  issuedAt?: number;
  lifetimeSeconds?: number;
}): string {
  const iat = options.issuedAt ?? Math.floor(Date.now() / 1000);
  return sign(
    { alg: 'RS256', typ: 'JWT' },
    {
      iss: options.clientEmail,
      scope: options.scope,
      aud: 'https://oauth2.googleapis.com/token',
      iat,
      exp: iat + (options.lifetimeSeconds ?? 3600)
    },
    options.privateKey,
    'sha256'
  );
}

/** Decodes a JWT's claims without verifying. For tests and diagnostics only. */
export function decodeClaims(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) {
    throw new Error('Malformed JWT');
  }
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** Decodes a JWT's header without verifying. For tests and diagnostics only. */
export function decodeHeader(token: string): Record<string, unknown> {
  const part = token.split('.')[0];
  if (!part) {
    throw new Error('Malformed JWT');
  }
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}
