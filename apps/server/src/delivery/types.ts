import type { DeadReason } from '../db/schema.ts';

/** A delivery this worker holds a lease on, with everything needed to send it. */
export type ClaimedDelivery = {
  id: string;
  eventId: string;
  endpointId: string;
  destinationId: string;
  /** Attempt number of THIS claim (already incremented). Part of the fencing token. */
  attemptCount: number;
  maxAttempts: number;
  trigger: 'auto' | 'manual';
  leaseOwner: string;
  leaseExpiresAt: Date;
  url: string;
  timeoutMs: number;
  method: string;
  headers: Record<string, string | string[]>;
  body: Buffer;
  contentType: string | null;
  /** Sealed signing secrets: current first, then the previous one inside the rotation window. */
  signingSecrets: SealedSigningSecret[];
};

export type SealedSigningSecret = {
  column: 'signing_secret_enc' | 'prev_signing_secret_enc';
  sealed: string;
};

/** What happened on the wire for one attempt. Always logged to delivery_attempts. */
export type AttemptResult = {
  startedAt: Date;
  durationMs: number;
  statusCode?: number | undefined;
  responseHeaders?: Record<string, string | string[]> | undefined;
  responseBodySnippet?: string | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
};

/** The decision for the delivery after an attempt. */
export type Outcome =
  { kind: 'succeeded' } | { kind: 'retry'; delayMs: number } | { kind: 'dead'; reason: DeadReason };
