// Destination URL rules (design §7.1). Static rules here; `validateDestinationUrl` adds the
// DNS + IP blocklist check used at creation. The same checks run again at send time
// (delivery/http-client.ts), because DNS answers can change after creation.
import { SsrfBlockedError, resolveAllowed } from '../delivery/ssrf.ts';
import type { ResolveFn } from '../delivery/ssrf.ts';

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

export async function validateDestinationUrl(
  raw: string,
  opts: { production: boolean; allowPrivate: boolean; resolve?: ResolveFn },
): Promise<UrlCheck> {
  const checked = checkDestinationUrl(raw, opts);
  if (!checked.ok) return checked;
  const hostname = new URL(checked.url).hostname.replace(/^\[(.*)\]$/, '$1');
  try {
    await resolveAllowed(hostname, {
      allowPrivate: opts.allowPrivate,
      ...(opts.resolve && { resolve: opts.resolve }),
    });
    return checked;
  } catch (error) {
    if (error instanceof SsrfBlockedError) return { ok: false, reason: error.message };
    return { ok: false, reason: 'hostname does not resolve' };
  }
}

export function checkDestinationUrl(raw: string, opts: { production: boolean }): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid absolute URL' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'scheme must be https (or http outside production)' };
  }
  if (opts.production && url.protocol !== 'https:') {
    return { ok: false, reason: 'https is required in production' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'URL must not contain credentials' };
  }

  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (port !== 443 && port < 1024) {
    return { ok: false, reason: 'port must be 443 or 1024 and above' };
  }

  url.hash = '';
  return { ok: true, url: url.toString() };
}
