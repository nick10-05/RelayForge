// OpenAPI 3.1 document + Swagger UI (design §2 F11).
//
// The request schemas come from the routes' own Zod schemas (jsonSchemaTransform), so the docs
// can't drift from what the server actually validates. What Zod can't know — a one-line summary,
// the tag, and whether a route is public or session-only — lives in ROUTE_DOCS below, keyed by
// "METHOD /url". A test fails if a route is missing from it, so new routes get documented.
//
// Served at /api/v1/docs (UI) and /api/v1/docs/json (the spec). Under /api so the dashboard's SPA
// fallback never swallows it. Swagger UI's page only loads same-origin scripts, so helmet's
// default CSP needs no exceptions.
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import { SESSION_COOKIE } from '../auth/sessions.ts';

export const DOCS_PREFIX = '/api/v1/docs';

type Access = 'public' | 'session' | 'session_or_key';
type RouteDoc = { tag: string; summary: string; description?: string; access?: Access };

const SECURITY: Record<Access, Record<string, string[]>[]> = {
  public: [],
  session: [{ session: [] }],
  session_or_key: [{ session: [] }, { apiKey: [] }],
};

const E = '/api/v1/endpoints';
const D = `${E}/{endpointId}/destinations`;

export const ROUTE_DOCS: Record<string, RouteDoc> = {
  'GET /healthz': {
    tag: 'Health',
    summary: 'Liveness (never touches the database)',
    access: 'public',
  },
  'GET /readyz': { tag: 'Health', summary: 'Readiness (database reachable)', access: 'public' },

  'POST /api/v1/auth/signup': {
    tag: 'Auth',
    summary: 'Create an account and start a session',
    access: 'public',
  },
  'POST /api/v1/auth/login': {
    tag: 'Auth',
    summary: 'Log in (sets the session cookie)',
    access: 'public',
  },
  'POST /api/v1/auth/logout': {
    tag: 'Auth',
    summary: 'Log out (revokes the session)',
    access: 'public',
  },
  'GET /api/v1/auth/me': { tag: 'Auth', summary: 'The signed-in user' },

  'POST /api/v1/api-keys': {
    tag: 'API keys',
    summary: 'Create an API key',
    description: 'The key is shown once in the response; only its hash is stored.',
    access: 'session',
  },
  'GET /api/v1/api-keys': {
    tag: 'API keys',
    summary: 'List API keys (no secrets)',
    access: 'session',
  },
  'DELETE /api/v1/api-keys/{id}': {
    tag: 'API keys',
    summary: 'Revoke an API key',
    access: 'session',
  },

  [`POST ${E}`]: {
    tag: 'Endpoints',
    summary: 'Create an endpoint (an ingest URL)',
    description:
      'The verification secret is write-only: it is encrypted at rest and never returned.',
  },
  [`GET ${E}`]: { tag: 'Endpoints', summary: 'List endpoints' },
  [`GET ${E}/{id}`]: { tag: 'Endpoints', summary: 'Get an endpoint' },
  [`PATCH ${E}/{id}`]: {
    tag: 'Endpoints',
    summary: 'Update an endpoint (name, pause, dedupe, verification)',
  },
  [`DELETE ${E}/{id}`]: { tag: 'Endpoints', summary: 'Delete an endpoint and its events' },

  [`POST ${D}`]: { tag: 'Destinations', summary: 'Add a destination (SSRF-checked URL)' },
  [`GET ${D}`]: { tag: 'Destinations', summary: 'List destinations' },
  [`GET ${D}/{id}`]: { tag: 'Destinations', summary: 'Get a destination' },
  [`PATCH ${D}/{id}`]: { tag: 'Destinations', summary: 'Update a destination' },
  [`DELETE ${D}/{id}`]: { tag: 'Destinations', summary: 'Delete a destination' },
  [`GET ${D}/{id}/secret`]: {
    tag: 'Destinations',
    summary: 'Reveal the signing secret',
    description: 'Also returns the previous secret while it still signs (24 h after a rotation).',
  },
  [`POST ${D}/{id}/rotate-secret`]: {
    tag: 'Destinations',
    summary: 'Rotate the signing secret',
    description:
      'The old secret keeps signing (second signature) for 24 h so receivers can switch.',
  },

  [`GET ${E}/{endpointId}/events`]: {
    tag: 'Events',
    summary: 'List events (newest first, cursor-paginated)',
  },
  'GET /api/v1/events/{id}': {
    tag: 'Events',
    summary: 'Get an event with its deliveries and attempts',
  },
  'GET /api/v1/events/{id}/body': {
    tag: 'Events',
    summary: 'Download the raw body',
    description:
      'Always application/octet-stream as an attachment, never the sender’s Content-Type.',
  },

  'POST /api/v1/events/{id}/replay': {
    tag: 'Redelivery',
    summary: 'Replay an event to its destinations',
    description: 'Creates new deliveries. Events with an invalid signature are never replayed.',
  },
  'POST /api/v1/deliveries/{id}/retry': {
    tag: 'Redelivery',
    summary: 'Retry a failed or dead delivery',
  },
  [`POST ${E}/{endpointId}/redeliver-dead`]: {
    tag: 'Redelivery',
    summary: 'Redeliver all dead deliveries of an endpoint',
    description: 'Optionally limited to one destination.',
  },

  'GET /api/v1/stats': {
    tag: 'Stats',
    summary: 'Counts and delivery health for your endpoints',
    description:
      'Events and deliveries currently retained, the claimable backlog (`due`), dead deliveries ' +
      'by reason, and the last 24 h of attempts (success rate, p50/p95 latency). Pass ' +
      '`endpointId` for a single endpoint.',
  },
};

/** "METHOD /url" with Fastify's `:param` turned into OpenAPI's `{param}`. */
export function routeKey(method: string, url: string): string {
  return `${method} ${url.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`;
}

const transform: typeof jsonSchemaTransform = (input) => {
  // Ingest is registered with app.all (every HTTP method, incl. WebDAV ones that OpenAPI 3.1
  // can't express); it is documented by hand in `paths` below instead.
  if (input.url.startsWith('/in/')) return { schema: { hide: true }, url: input.url };

  // A plugin's '/' route is reachable with and without the slash; document the bare form.
  const url = input.url.length > 1 ? input.url.replace(/\/$/, '') : input.url;
  const result = jsonSchemaTransform(input);
  const method = [input.route.method].flat()[0] ?? 'GET';
  const doc = ROUTE_DOCS[routeKey(method, url)];
  if (!doc) return { ...result, url };
  return {
    url,
    schema: {
      ...result.schema,
      tags: [doc.tag],
      summary: doc.summary,
      ...(doc.description && { description: doc.description }),
      security: SECURITY[doc.access ?? 'session_or_key'],
    },
  };
};

const ingestPath = {
  post: {
    tags: ['Ingest'],
    summary: 'Receive a webhook',
    description:
      'Any HTTP method and any sub-path are accepted (`/in/{slug}/anything`). The slug is the ' +
      'capability: no other credentials. Bodies up to 1 MB of any content type are stored as ' +
      'received; a configured signature check runs first (failures are stored, never forwarded).',
    security: [],
    parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' as const } }],
    requestBody: { content: { '*/*': { schema: {} } } },
    responses: {
      '202': { description: 'Stored: `{ "eventId": "..." }`' },
      '200': { description: 'Duplicate of a stored event: `{ "eventId", "duplicate": true }`' },
      '401': {
        description: 'Signature check failed (stored 24 h for inspection, never forwarded)',
      },
      '404': { description: 'Unknown slug' },
      '413': { description: 'Body over 1 MB' },
      '429': { description: 'Rate limited (see `Retry-After`)' },
      '503': { description: 'Storage nearly full or secret unavailable; retry later' },
    },
  },
};

/** Queues both plugins (no await, so they load in order with the app's other plugins). */
export function registerOpenApi(app: FastifyInstance): void {
  // Must be registered before the routes: it collects them through an onRoute hook.
  void app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'RelayForge API',
        version: '1.0.0',
        description:
          'Receive webhooks, store them durably, forward them with retries, and inspect or ' +
          'redeliver them. Errors are JSON: `{ "error": "<code>", "message": "..." }`.\n\n' +
          'Browser calls use the session cookie (state-changing requests must come from the ' +
          'dashboard origin); scripts use `Authorization: Bearer rf_live_...`.',
      },
      tags: [
        { name: 'Ingest', description: 'Where webhook providers send events' },
        { name: 'Auth' },
        { name: 'API keys', description: 'Session only: an API key cannot mint keys' },
        { name: 'Endpoints' },
        { name: 'Destinations' },
        { name: 'Events' },
        { name: 'Redelivery' },
        { name: 'Stats' },
        { name: 'Health' },
      ],
      components: {
        securitySchemes: {
          session: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE },
          apiKey: { type: 'http', scheme: 'bearer', description: 'An API key: `rf_live_...`' },
        },
      },
      paths: { '/in/{slug}': ingestPath },
    },
    transform,
  });

  void app.register(swaggerUi, {
    routePrefix: DOCS_PREFIX,
    // The default validator badge would call validator.swagger.io with our spec.
    uiConfig: { validatorUrl: null, deepLinking: true },
  });
}
