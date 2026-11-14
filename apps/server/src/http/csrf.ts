// CSRF protection (design §7.3) = SameSite=Lax session cookie + an Origin check.
//
// SameSite=Lax already keeps the cookie off cross-site POST/PUT/PATCH/DELETE requests in
// modern browsers. The Origin check is the second layer (older browsers, same-site but
// cross-origin attackers such as another subdomain): browsers always send `Origin` on
// state-changing requests, and a page can't forge it. So any state-changing /api request
// that could be riding on a cookie must carry an Origin we serve the dashboard from.
//
// Not checked:
//   - safe methods (GET/HEAD/OPTIONS): they never change state;
//   - requests with an Authorization header (API keys): no ambient credential, nothing to ride
//     on — and a cross-site page can't add that header without a CORS preflight we never allow;
//   - /in/* ingest: called by webhook providers, no cookies, and the slug is the capability.
import type { FastifyReply, FastifyRequest } from 'fastify';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const CSRF_REFUSED = {
  error: 'csrf_origin_mismatch',
  message: 'Cross-origin request refused',
} as const;

export const DEV_ORIGINS = 'http://localhost:3000,http://127.0.0.1:3000';

export function parseOrigins(value: string): Set<string> {
  return new Set(
    value
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  );
}

export function createOriginCheck(allowed: ReadonlySet<string>) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (SAFE_METHODS.has(request.method)) return;
    if (!request.url.startsWith('/api/')) return;
    if (request.headers.authorization !== undefined) return;
    const origin = request.headers.origin;
    // "null" (sandboxed iframes, some redirects) is never allowed.
    if (origin === undefined || !allowed.has(origin)) {
      return reply.code(403).send(CSRF_REFUSED);
    }
  };
}
