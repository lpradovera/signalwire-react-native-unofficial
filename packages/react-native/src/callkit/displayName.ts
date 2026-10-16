import { logger } from '@signalwire/react';

/**
 * Names the backend sends in a name field that are not names. A call placed
 * by REST `calling.dial` with no caller name arrives with
 * `caller_id_name: "_undef_"` in its `verto.invite`, which the SDK passes on
 * as `fromName`. That is a backend defect (reported separately), not a name
 * to show; it is logged so it stays visible.
 */
const PLACEHOLDER_NAMES = new Set(['_undef_']);

/** Whether `name` is empty or a placeholder (see {@link PLACEHOLDER_NAMES}) rather than a name. */
export function isPlaceholderName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed === '' || PLACEHOLDER_NAMES.has(trimmed);
}

/** `rn-device-test` -> `Rn Device Test`; null when nothing readable is left. */
function humanise(segment: string): string | null {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A stray '%': the segment as it is.
  }
  const words = decoded.split(/[\s._-]+/).filter((word) => word.length > 0);
  if (words.length === 0) {
    return null;
  }
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/**
 * A readable form of a Fabric address or SIP URI, for a call's name in the
 * native call UI and Recents: the address's last segment, humanised
 * (`/private/rn-device-test` -> `Rn Device Test`; a SIP URI's user part, so
 * `sip:rn-example@<project-id>.call.signalwire.com;context=private` -> `Rn Example`,
 * without the project id). Anything else (a number, a name) is returned as it
 * is. Null when the address has no readable part (`/private/`).
 */
export function readableAddress(value: string): string | null {
  const trimmed = value.trim();
  const fabric = /^\/(?:private|public)\/([^?#]*)/.exec(trimmed);
  if (fabric) {
    const segments = (fabric[1] ?? '').split('/').filter((segment) => segment.length > 0);
    const last = segments[segments.length - 1];
    return last === undefined ? null : humanise(last);
  }
  const sip = /^sips?:([^@;?]*)@/i.exec(trimmed);
  if (sip) {
    return humanise(sip[1] ?? '');
  }
  return trimmed;
}

/**
 * The name to show for `name`: null for a placeholder or empty name (a
 * placeholder is logged, with `context` naming where it came from), and an
 * address made readable ({@link readableAddress}).
 */
export function displayableName(name: string | undefined | null, context: string): string | null {
  if (name === undefined || name === null) {
    return null;
  }
  if (isPlaceholderName(name)) {
    if (name.trim() !== '') {
      logger.debug(`${context}: placeholder name "${name.trim()}" received; not showing it`);
    }
    return null;
  }
  return readableAddress(name);
}
