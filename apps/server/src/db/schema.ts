// Database schema (design §6). Ids are app-generated UUIDv7; enums are text + CHECK
// constraints (easier to extend than Postgres enum types, and no TypeScript `enum`).
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../lib/uuidv7.ts';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());
const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const VERIFY_SCHEMES = ['none', 'hmac', 'standard_webhooks'] as const;
export const VERIFY_ENCODINGS = ['hex', 'base64'] as const;
export const DEDUPE_SOURCES = ['none', 'header', 'json_field'] as const;
export const SIGNATURE_STATUSES = ['not_checked', 'valid', 'invalid'] as const;
export const DELIVERY_STATUSES = ['pending', 'in_flight', 'succeeded', 'dead'] as const;
export const DEAD_REASONS = [
  'exhausted',
  'non_retryable_status',
  'redirect',
  'ssrf_blocked',
  'destination_disabled',
] as const;
export const DELIVERY_TRIGGERS = ['auto', 'manual'] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export type DeadReason = (typeof DEAD_REASONS)[number];
export type DedupeSource = (typeof DEDUPE_SOURCES)[number];
export type VerifyScheme = (typeof VERIFY_SCHEMES)[number];
export type VerifyEncoding = (typeof VERIFY_ENCODINGS)[number];

/** SQL `col IN ('a','b')` for a CHECK constraint. Values are our own constants, never input. */
const oneOf = (column: AnyPgColumn, values: readonly string[]) =>
  sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(t.email),
    check('users_email_lowercase', sql`${t.email} = lower(${t.email})`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: createdAt(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_uq').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    secretHash: text('secret_hash').notNull(),
    lastUsedAt: tstz('last_used_at'),
    revokedAt: tstz('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('api_keys_prefix_uq').on(t.prefix), index('api_keys_user_idx').on(t.userId)],
);

export const endpoints = pgTable(
  'endpoints',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    paused: boolean('paused').notNull().default(false),
    verifyScheme: text('verify_scheme', { enum: VERIFY_SCHEMES }).notNull().default('none'),
    verifyHeader: text('verify_header'),
    verifyPrefix: text('verify_prefix'),
    verifyEncoding: text('verify_encoding', { enum: VERIFY_ENCODINGS }),
    verifySecretEnc: text('verify_secret_enc'),
    dedupeSource: text('dedupe_source', { enum: DEDUPE_SOURCES }).notNull().default('none'),
    dedupeName: text('dedupe_name'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('endpoints_slug_uq').on(t.slug),
    index('endpoints_user_idx').on(t.userId, t.createdAt),
    check('endpoints_verify_scheme_chk', oneOf(t.verifyScheme, VERIFY_SCHEMES)),
    check(
      'endpoints_verify_encoding_chk',
      sql`${t.verifyEncoding} IS NULL OR ${oneOf(t.verifyEncoding, VERIFY_ENCODINGS)}`,
    ),
    check('endpoints_dedupe_source_chk', oneOf(t.dedupeSource, DEDUPE_SOURCES)),
    check(
      'endpoints_dedupe_name_chk',
      sql`(${t.dedupeSource} = 'none') = (${t.dedupeName} IS NULL)`,
    ),
  ],
);

export const destinations = pgTable(
  'destinations',
  {
    id: id(),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => endpoints.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    timeoutMs: integer('timeout_ms').notNull().default(10000),
    maxAttempts: integer('max_attempts').notNull().default(10),
    signingSecretEnc: text('signing_secret_enc'),
    prevSigningSecretEnc: text('prev_signing_secret_enc'),
    prevSecretExpiresAt: tstz('prev_secret_expires_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('destinations_endpoint_idx').on(t.endpointId),
    check('destinations_timeout_chk', sql`${t.timeoutMs} BETWEEN 1000 AND 15000`),
    check('destinations_max_attempts_chk', sql`${t.maxAttempts} BETWEEN 1 AND 15`),
  ],
);

export const events = pgTable(
  'events',
  {
    id: id(),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => endpoints.id, { onDelete: 'cascade' }),
    method: text('method').notNull(),
    path: text('path').notNull(),
    query: text('query'),
    headers: jsonb('headers').$type<Record<string, string | string[]>>().notNull(),
    body: bytea('body').notNull(),
    bodyTruncated: boolean('body_truncated').notNull().default(false),
    contentType: text('content_type'),
    sizeBytes: integer('size_bytes').notNull(),
    sourceIp: text('source_ip'),
    dedupeKey: text('dedupe_key'),
    duplicateCount: integer('duplicate_count').notNull().default(0),
    lastDuplicateAt: tstz('last_duplicate_at'),
    signatureStatus: text('signature_status', { enum: SIGNATURE_STATUSES })
      .notNull()
      .default('not_checked'),
    signatureFailureReason: text('signature_failure_reason'),
    // Millisecond precision so keyset cursors (JS Date) compare exactly.
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date', precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('events_endpoint_dedupe_key_uq')
      .on(t.endpointId, t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL`),
    index('events_endpoint_received_idx').on(t.endpointId, t.receivedAt.desc(), t.id.desc()),
    index('events_invalid_received_idx')
      .on(t.receivedAt)
      .where(sql`${t.signatureStatus} = 'invalid'`),
    check('events_signature_status_chk', oneOf(t.signatureStatus, SIGNATURE_STATUSES)),
  ],
);

export const deliveries = pgTable(
  'deliveries',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    destinationId: uuid('destination_id')
      .notNull()
      .references(() => destinations.id, { onDelete: 'cascade' }),
    status: text('status', { enum: DELIVERY_STATUSES }).notNull().default('pending'),
    deadReason: text('dead_reason', { enum: DEAD_REASONS }),
    trigger: text('trigger', { enum: DELIVERY_TRIGGERS }).notNull().default('auto'),
    replayOf: uuid('replay_of').references((): AnyPgColumn => deliveries.id, {
      onDelete: 'set null',
    }),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    nextAttemptAt: tstz('next_attempt_at').notNull().defaultNow(),
    leaseOwner: text('lease_owner'),
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),
    completedAt: tstz('completed_at'),
    createdAt: createdAt(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('deliveries_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} IN ('pending', 'in_flight')`),
    uniqueIndex('deliveries_one_active_uq')
      .on(t.eventId, t.destinationId)
      .where(sql`${t.status} IN ('pending', 'in_flight')`),
    index('deliveries_event_idx').on(t.eventId),
    index('deliveries_destination_idx').on(t.destinationId),
    check('deliveries_status_chk', oneOf(t.status, DELIVERY_STATUSES)),
    check(
      'deliveries_dead_reason_chk',
      sql`(${t.status} = 'dead') = (${t.deadReason} IS NOT NULL) AND (${t.deadReason} IS NULL OR ${oneOf(t.deadReason, DEAD_REASONS)})`,
    ),
    check('deliveries_trigger_chk', oneOf(t.trigger, DELIVERY_TRIGGERS)),
    check(
      'deliveries_attempts_chk',
      sql`${t.attemptCount} >= 0 AND ${t.maxAttempts} BETWEEN 1 AND 15`,
    ),
  ],
);

export const deliveryAttempts = pgTable(
  'delivery_attempts',
  {
    id: id(),
    deliveryId: uuid('delivery_id')
      .notNull()
      .references(() => deliveries.id, { onDelete: 'cascade' }),
    attemptNo: integer('attempt_no').notNull(),
    workerId: text('worker_id').notNull(),
    startedAt: tstz('started_at').notNull(),
    durationMs: integer('duration_ms'),
    statusCode: integer('status_code'),
    responseHeaders: jsonb('response_headers').$type<Record<string, string | string[]>>(),
    responseBodySnippet: text('response_body_snippet'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
  },
  (t) => [index('delivery_attempts_delivery_idx').on(t.deliveryId, t.attemptNo)],
);
