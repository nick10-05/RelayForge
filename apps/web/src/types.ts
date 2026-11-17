// Response shapes of the RelayForge API (apps/server). Dates arrive as ISO strings.

export type User = { id: string; email: string; createdAt: string };

export type Endpoint = {
  id: string;
  name: string;
  slug: string;
  ingestPath: string;
  paused: boolean;
  dedupeSource: 'none' | 'header' | 'json_field';
  dedupeName: string | null;
  verification: {
    scheme: 'none' | 'hmac' | 'standard_webhooks';
    header: string | null;
    prefix: string | null;
    encoding: 'hex' | 'base64' | null;
    hasSecret: boolean;
  };
  createdAt: string;
};

export type Destination = {
  id: string;
  endpointId: string;
  url: string;
  enabled: boolean;
  timeoutMs: number;
  maxAttempts: number;
  createdAt: string;
};

export type SignatureStatus = 'not_checked' | 'valid' | 'invalid';

/** A row in the event list (GET /api/v1/endpoints/:id/events). */
export type EventSummary = {
  id: string;
  endpointId: string;
  method: string;
  path: string;
  contentType: string | null;
  sizeBytes: number;
  dedupeKey: string | null;
  duplicateCount: number;
  signatureStatus: SignatureStatus;
  receivedAt: string;
};

export type EventPage = { events: EventSummary[]; nextCursor: string | null };

export type DeliveryStatus = 'pending' | 'in_flight' | 'succeeded' | 'dead';
export type DeadReason =
  'exhausted' | 'non_retryable_status' | 'redirect' | 'ssrf_blocked' | 'destination_disabled';

/** One HTTP attempt to send a delivery (oldest first in Delivery.attempts). */
export type DeliveryAttempt = {
  attemptNo: number;
  startedAt: string;
  durationMs: number | null;
  /** null when no HTTP response came back (see errorCode). */
  statusCode: number | null;
  responseHeaders: Record<string, string | string[]> | null;
  /** First 4 KB of the receiver's reply. */
  responseBodySnippet: string | null;
  /** e.g. TIMEOUT, CONNECT_TIMEOUT, ECONNRESET, SSRF_BLOCKED, SIGNING_FAILED. */
  errorCode: string | null;
  errorMessage: string | null;
};

export type Delivery = {
  id: string;
  destinationId: string;
  destinationUrl: string;
  status: DeliveryStatus;
  deadReason: DeadReason | null;
  trigger: 'auto' | 'manual';
  /** For a manual redelivery: the delivery it re-sends. */
  replayOf: string | null;
  attemptCount: number;
  maxAttempts: number;
  /** When it is next tried (pending), or when the current lease ends (in_flight). */
  nextAttemptAt: string;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
  attempts: DeliveryAttempt[];
};

/** GET /api/v1/events/:id */
export type EventDetail = EventSummary & {
  query: string | null;
  headers: Record<string, string | string[]>;
  /** utf8 when the bytes are valid UTF-8, otherwise base64. */
  body: { encoding: 'utf8' | 'base64'; data: string };
  /** Invalid-signature events keep only the first 64 KB (sizeBytes is the real size). */
  bodyTruncated: boolean;
  sourceIp: string | null;
  lastDuplicateAt: string | null;
  /** missing_header | malformed | mismatch | timestamp_out_of_tolerance (invalid only). */
  signatureFailureReason: string | null;
  deliveries: Delivery[];
};

/** GET /api/v1/stats (optionally ?endpointId=). Counts cover retained data (7 days). */
export type Stats = {
  generatedAt: string;
  endpointId: string | null;
  endpoints: number;
  events: {
    stored: number;
    last24h: number;
    duplicatesReceived: number;
    invalidSignature: number;
    invalidSignatureDroppedSinceStart: number;
  };
  deliveries: {
    pending: number;
    inFlight: number;
    succeeded: number;
    dead: number;
    /** Claimable right now (backlog). */
    due: number;
    deadByReason: Record<DeadReason, number>;
  };
  attemptsLast24h: {
    total: number;
    succeeded: number;
    successRate: number | null;
    latencyMs: { p50: number | null; p95: number | null };
  };
  /** By hour, oldest first: 25 buckets covering the last 24 h (both ends partial). */
  series: { hour: string; events: number; delivered: number; failed: number }[];
};
