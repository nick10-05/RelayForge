// Serves the built dashboard (apps/web/dist) from this process, on the same origin as the API
// (design §3): the session cookie stays first-party and there is no CORS to configure.
//
// Routing: real files are served as they are; any other GET for a "page" (no file extension,
// not /api, /in or a health route, and the client accepts HTML) gets index.html so the
// client-side router can render it — that's what makes deep links and refreshes work.
// Everything else keeps the API's JSON 404.
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';
const SERVER_PREFIXES = ['/api', '/in', '/healthz', '/readyz'];

type PageRequest = { method: string; url: string; headers: { accept?: string | undefined } };

export function isSpaPage(request: PageRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const path = request.url.split('?')[0] ?? '/';
  if (SERVER_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return false;
  const lastSegment = path.slice(path.lastIndexOf('/') + 1);
  if (lastSegment.includes('.')) return false; // a file that wasn't found: a real 404
  return (request.headers.accept ?? '').includes('text/html');
}

export async function spaRoutes(app: FastifyInstance, opts: { root: string }) {
  await app.register(fastifyStatic, {
    root: opts.root,
    wildcard: true,
    index: ['index.html'],
    cacheControl: false, // set below, per file
    setHeaders: (reply, filePath) => {
      // Vite puts content-hashed files in assets/: a new build means a new name, so they can be
      // cached forever. index.html (and anything unhashed) must be revalidated on every load.
      const inAssets = /[\\/]assets[\\/]/.test(filePath);
      void reply.header('cache-control', inAssets ? IMMUTABLE : REVALIDATE);
    },
  });
}

export function sendSpaIndex(reply: FastifyReply) {
  return reply.header('cache-control', REVALIDATE).sendFile('index.html');
}
