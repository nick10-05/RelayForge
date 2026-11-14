// Static URL rules checked when a destination is created or changed (design §7.1).
// The SSRF guard (DNS resolution + IP blocklist, at creation and at send time) is Day 5.

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

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
