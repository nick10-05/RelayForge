// Pure display logic for the event detail page (no React): what to show for a body, which
// headers to mask, how to word statuses. Kept here so it is unit-tested and the page component
// only does layout.
//
// Security: everything below produces plain strings that React renders as text. Event bodies,
// headers and receiver replies are attacker-controlled; nothing here builds HTML.
import type {
  DeadReason,
  Delivery,
  DeliveryAttempt,
  DeliveryStatus,
  EventDetail,
} from '../types.ts';

export type Tone = 'slate' | 'green' | 'amber' | 'red';

/** Bodies longer than this (in characters) are cut for display; the download has every byte. */
export const BODY_DISPLAY_LIMIT = 200_000;
export const HEX_PREVIEW_BYTES = 256;

export type BodyView =
  | { kind: 'empty' }
  | { kind: 'json'; text: string; cut: boolean }
  | { kind: 'text'; text: string; cut: boolean }
  | { kind: 'binary'; hex: string; previewBytes: number };

/** JSON is pretty-printed, other UTF-8 shown as-is, anything else as a hex preview. */
export function viewBody(body: EventDetail['body'], limit = BODY_DISPLAY_LIMIT): BodyView {
  if (body.encoding === 'base64') {
    const bytes = base64ToBytes(body.data);
    if (bytes.length === 0) return { kind: 'empty' };
    const preview = bytes.subarray(0, HEX_PREVIEW_BYTES);
    return { kind: 'binary', hex: hexDump(preview), previewBytes: preview.length };
  }
  if (body.data.length === 0) return { kind: 'empty' };
  const pretty = prettyJson(body.data);
  const text = pretty ?? body.data;
  const cut = text.length > limit;
  return { kind: pretty === null ? 'text' : 'json', text: cut ? text.slice(0, limit) : text, cut };
}

function prettyJson(text: string): string | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null; // "42" isn't worth it
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Classic hex dump: offset, 16 bytes in hex, printable ASCII (others as "."). */
export function hexDump(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = Array.from(bytes.subarray(offset, offset + 16));
    const hex = row.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = row.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  |${ascii}|`);
  }
  return lines.join('\n');
}

/**
 * Request headers that carry credentials. They are stored as received (for inspection) but
 * masked by default so they don't leak through a screen share or a screenshot.
 */
export const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
]);

export type HeaderRow = { name: string; value: string; sensitive: boolean };

/** One row per value (a repeated header is an array), sorted by name. */
export function headerRows(headers: EventDetail['headers']): HeaderRow[] {
  return Object.entries(headers)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([name, value]) =>
      (Array.isArray(value) ? value : [value]).map((v) => ({
        name,
        value: v,
        sensitive: SENSITIVE_HEADERS.has(name.toLowerCase()),
      })),
    );
}

export const MASK = '•••••••• (hidden)';

const SIGNATURE_REASONS: Record<string, string> = {
  missing_header: 'The signature header was missing.',
  malformed: 'The signature header was malformed (or sent more than once).',
  mismatch: 'The signature did not match the body and secret.',
  timestamp_out_of_tolerance: 'The signed timestamp was too old or in the future (replay guard).',
};

export function signatureReasonText(reason: string | null): string {
  return (reason && SIGNATURE_REASONS[reason]) ?? 'The signature could not be verified.';
}

const DEAD_REASONS: Record<DeadReason, string> = {
  exhausted: 'gave up after the last attempt',
  non_retryable_status: 'the receiver answered with a status that retrying cannot fix',
  redirect: 'the receiver answered with a redirect (not followed, by design)',
  ssrf_blocked: 'the destination resolved to a blocked (private or internal) address',
  destination_disabled: 'the destination was disabled',
};

export function deliveryStatusView(d: Pick<Delivery, 'status' | 'deadReason'>): {
  label: string;
  tone: Tone;
  detail: string | null;
} {
  const labels: Record<DeliveryStatus, { label: string; tone: Tone }> = {
    pending: { label: 'pending', tone: 'amber' },
    in_flight: { label: 'sending', tone: 'amber' },
    succeeded: { label: 'succeeded', tone: 'green' },
    dead: { label: 'dead', tone: 'red' },
  };
  return {
    ...labels[d.status],
    detail: d.status === 'dead' && d.deadReason ? DEAD_REASONS[d.deadReason] : null,
  };
}

/** What one attempt came back with: an HTTP status, or the error when there was no response. */
export function attemptOutcome(a: Pick<DeliveryAttempt, 'statusCode' | 'errorCode'>): {
  label: string;
  tone: Tone;
} {
  if (a.statusCode !== null) {
    const ok = a.statusCode >= 200 && a.statusCode < 300;
    return { label: `HTTP ${a.statusCode}`, tone: ok ? 'green' : 'red' };
  }
  return { label: a.errorCode ?? 'no response', tone: 'red' };
}

/** Why an event has no deliveries — shown instead of an empty list. */
export function noDeliveriesText(event: Pick<EventDetail, 'signatureStatus'>): string {
  return event.signatureStatus === 'invalid'
    ? 'Not forwarded: the signature was invalid. Invalid events are stored for inspection only and can never be replayed.'
    : 'Not forwarded: the endpoint had no enabled destinations when this event arrived. Add or enable one, then replay.';
}
