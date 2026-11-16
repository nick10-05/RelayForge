// Form logic for an endpoint's inbound settings: signature verification and de-duplication.
// Pure functions, so they are unit-tested without rendering. The server validates again and is
// the authority; these checks only give faster, friendlier feedback.
import type { Endpoint } from '../types.ts';

type Verification = Endpoint['verification'];
export type Scheme = Verification['scheme'];
export type Encoding = 'hex' | 'base64';

export type VerificationForm = {
  scheme: Scheme;
  header: string;
  prefix: string;
  encoding: Encoding;
  /** Write-only on the server: always starts empty and must be re-entered to save a change. */
  secret: string;
};

export type VerificationPayload =
  | { scheme: 'none' }
  | { scheme: 'hmac'; header: string; prefix: string | null; encoding: Encoding; secret: string }
  | { scheme: 'standard_webhooks'; secret: string };

/** Providers whose HMAC format is header + optional prefix + hex/base64 over the raw body. */
export const HMAC_PRESETS: { name: string; header: string; prefix: string; encoding: Encoding }[] =
  [
    { name: 'GitHub', header: 'x-hub-signature-256', prefix: 'sha256=', encoding: 'hex' },
    { name: 'Shopify', header: 'x-shopify-hmac-sha256', prefix: '', encoding: 'base64' },
  ];

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export function verificationForm(v: Verification): VerificationForm {
  return {
    scheme: v.scheme,
    header: v.header ?? '',
    prefix: v.prefix ?? '',
    encoding: v.encoding ?? 'hex',
    secret: '',
  };
}

/** The PATCH body for `verification`, or a message saying what is missing. */
export function verificationPayload(form: VerificationForm): VerificationPayload | string {
  if (form.scheme === 'none') return { scheme: 'none' };
  const secret = form.secret.trim();
  if (!secret) return 'Enter the signing secret (it is never shown again once saved).';
  if (form.scheme === 'standard_webhooks') {
    if (!secret.startsWith('whsec_')) return 'A Standard Webhooks secret starts with "whsec_".';
    return { scheme: 'standard_webhooks', secret };
  }
  const header = form.header.trim();
  if (!header) return 'Enter the header that carries the signature.';
  if (!HEADER_NAME.test(header)) return `"${header}" is not a valid HTTP header name.`;
  return {
    scheme: 'hmac',
    header: header.toLowerCase(),
    prefix: form.prefix === '' ? null : form.prefix,
    encoding: form.encoding,
    secret,
  };
}

/** One line describing the current configuration. */
export function describeVerification(v: Verification): string {
  const secret = v.hasSecret ? 'secret set' : 'no secret';
  switch (v.scheme) {
    case 'none':
      return 'Off: every request is accepted and forwarded.';
    case 'standard_webhooks':
      return `Standard Webhooks (webhook-id / webhook-timestamp / webhook-signature, 5 min tolerance) · ${secret}`;
    case 'hmac':
      return (
        `HMAC-SHA256 in "${v.header ?? '?'}"` +
        (v.prefix ? `, prefix "${v.prefix}"` : '') +
        `, ${v.encoding ?? '?'} · ${secret}`
      );
  }
}

export type DedupeForm = { source: Endpoint['dedupeSource']; name: string };

export function dedupePayload(
  form: DedupeForm,
): { dedupeSource: DedupeForm['source']; dedupeName: string | null } | string {
  if (form.source === 'none') return { dedupeSource: 'none', dedupeName: null };
  const name = form.name.trim();
  if (!name) {
    return form.source === 'header'
      ? 'Enter the header that carries the event id (e.g. x-github-delivery).'
      : 'Enter the top-level JSON field that holds the event id (e.g. id).';
  }
  if (form.source === 'header' && !HEADER_NAME.test(name)) {
    return `"${name}" is not a valid HTTP header name.`;
  }
  return {
    dedupeSource: form.source,
    dedupeName: form.source === 'header' ? name.toLowerCase() : name,
  };
}
