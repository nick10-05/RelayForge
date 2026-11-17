/**
 * Where to go after login. Only same-site paths are allowed: `?next=https://evil.example` or
 * `?next=//evil.example` (protocol-relative) would otherwise turn our login page into an
 * open redirect that phishing links can borrow our domain for.
 */
export function safeNext(value: string | null, fallback = '/overview'): string {
  if (!value?.startsWith('/')) return fallback;
  // Browsers treat a backslash like a slash, so "/\evil.example" is protocol-relative too.
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback;
  return value;
}
