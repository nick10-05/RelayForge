// Outbound HTTP for deliveries (design §4.7, §7.1): node:http/https only, no client library,
// so every safety property is visible here.
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { unconfiguredBox } from '../crypto/secret-box.ts';
import type { SecretBox } from '../crypto/secret-box.ts';
import { checkDestinationUrl } from '../destinations/url.ts';
import { signatureHeaders } from './signing.ts';
import { createGuardedLookup, isBlockedAddress } from './ssrf.ts';
import type { ResolveFn } from './ssrf.ts';
import type { AttemptResult, ClaimedDelivery } from './types.ts';
import type { SendFn } from './worker.ts';

export const CONNECT_TIMEOUT_MS = 5000;
export const MAX_RESPONSE_BYTES = 4096;
const MAX_RESPONSE_HEADERS = 50;
const MAX_HEADER_VALUE = 512;

/** Hop-by-hop or sensitive request headers that are never forwarded (design §4.7). */
const STRIPPED = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'content-length', // recomputed
  'cookie',
  'expect',
]);

export function buildForwardHeaders(
  claim: ClaimedDelivery,
  signing?: { secrets: string[]; timestamp: number },
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(claim.headers)) {
    const lower = name.toLowerCase();
    if (STRIPPED.has(lower) || lower.startsWith('proxy-')) continue;
    if (lower.startsWith('x-relayforge-')) continue; // a sender must not spoof our headers
    out[lower] = value;
  }
  out['content-length'] = String(claim.body.length);
  out['x-relayforge-id'] = claim.eventId; // same across retries, fan-out and replays
  out['x-relayforge-delivery-id'] = claim.id;
  out['x-relayforge-attempt'] = String(claim.attemptCount);
  if (claim.trigger === 'manual') out['x-relayforge-replay'] = 'true';
  if (signing && signing.secrets.length > 0) {
    Object.assign(
      out,
      signatureHeaders({
        id: claim.eventId,
        timestamp: signing.timestamp,
        body: claim.body,
        secrets: signing.secrets,
      }),
    );
  }
  return out;
}

export type HttpSenderOptions = {
  production: boolean;
  allowPrivate: boolean;
  resolve?: ResolveFn;
  connectTimeoutMs?: number;
  /** Opens sealed signing secrets. Without one, a signed destination fails SIGNING_FAILED. */
  secretBox?: SecretBox;
  /** Unix-ms clock for the signature timestamp (injectable for tests). */
  now?: () => number;
};

/** Signing secrets in clear for one attempt. Throws if a sealed value can't be opened. */
export function openSigningSecrets(claim: ClaimedDelivery, box: SecretBox): string[] {
  return claim.signingSecrets.map((s) =>
    box.open(s.sealed, { table: 'destinations', column: s.column, rowId: claim.destinationId }),
  );
}

export function createHttpSender(options: HttpSenderOptions): SendFn {
  const lookup = createGuardedLookup({
    allowPrivate: options.allowPrivate,
    ...(options.resolve && { resolve: options.resolve }),
  });
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const secretBox = options.secretBox ?? unconfiguredBox;
  const now = options.now ?? Date.now;

  return (claim) =>
    new Promise<AttemptResult>((resolve) => {
      const startedAt = new Date();
      const t0 = performance.now();
      let done = false;
      const timers: { total?: NodeJS.Timeout; connect?: NodeJS.Timeout } = {};
      const finish = (result: Partial<AttemptResult>) => {
        if (done) return;
        done = true;
        clearTimeout(timers.total);
        clearTimeout(timers.connect);
        resolve({ startedAt, durationMs: performance.now() - t0, ...result });
      };

      // Re-validate at send time: rules may be stricter now, and the URL may predate them.
      const checked = checkDestinationUrl(claim.url, { production: options.production });
      if (!checked.ok) {
        finish({
          errorCode: 'SSRF_BLOCKED',
          errorMessage: `destination URL rejected: ${checked.reason}`,
        });
        return;
      }
      const url = new URL(checked.url);
      const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1'); // IPv6 literals come bracketed
      // Node skips `lookup` for IP literals, so they are vetted here instead.
      if (isIP(hostname) !== 0 && !options.allowPrivate && isBlockedAddress(hostname)) {
        finish({ errorCode: 'SSRF_BLOCKED', errorMessage: 'destination address is not allowed' });
        return;
      }

      let headers: Record<string, string | string[]>;
      try {
        // Timestamp per attempt: a retry hours later still passes the receiver's tolerance check.
        const timestamp = Math.floor(now() / 1000);
        headers = buildForwardHeaders(claim, {
          secrets: openSigningSecrets(claim, secretBox),
          timestamp,
        });
      } catch {
        // Never send unsigned when a secret is configured; never echo the secret in the error.
        finish({ errorCode: 'SIGNING_FAILED', errorMessage: 'signing secret could not be opened' });
        return;
      }

      const transport = url.protocol === 'https:' ? https : http;
      const request = transport.request({
        protocol: url.protocol,
        hostname,
        port: url.port === '' ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: claim.method,
        headers,
        lookup,
        agent: false, // fresh, vetted connection per attempt; no pooled sockets
        maxHeaderSize: 16 * 1024,
      });

      let response: Pick<AttemptResult, 'statusCode' | 'responseHeaders'> | undefined;
      const chunks: Buffer[] = [];
      let received = 0;
      const snippet = () => Buffer.concat(chunks).toString('utf8');

      timers.connect = setTimeout(() => {
        request.destroy(
          codeError('CONNECT_TIMEOUT', `no connection within ${connectTimeoutMs} ms`),
        );
      }, connectTimeoutMs);
      request.on('socket', (socket) => {
        if (!socket.connecting) clearTimeout(timers.connect);
        else socket.once('connect', () => clearTimeout(timers.connect));
      });

      timers.total = setTimeout(() => {
        if (response) {
          // Headers arrived but the body is slow: the status is what matters.
          finish({ ...response, responseBodySnippet: snippet() });
          request.destroy();
        } else {
          request.destroy(codeError('TIMEOUT', `no response within ${claim.timeoutMs} ms`));
        }
      }, claim.timeoutMs);

      request.on('response', (res) => {
        response = { statusCode: res.statusCode, responseHeaders: capHeaders(res.headers) };
        const complete = () => finish({ ...response, responseBodySnippet: snippet() });
        res.on('data', (chunk: Buffer) => {
          const room = MAX_RESPONSE_BYTES - received;
          if (room > 0) chunks.push(chunk.subarray(0, room));
          received += chunk.length;
          if (received >= MAX_RESPONSE_BYTES) {
            complete(); // read at most 4 KB, then hang up
            res.destroy();
          }
        });
        res.on('end', complete);
        res.on('close', complete);
        res.on('error', complete);
      });

      request.on('error', (error: NodeJS.ErrnoException) => {
        if (response) {
          finish({ ...response, responseBodySnippet: snippet() });
          return;
        }
        finish({ errorCode: error.code ?? error.name, errorMessage: error.message });
      });

      request.end(claim.body);
    });
}

function codeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function capHeaders(headers: http.IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  let count = 0;
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (++count > MAX_RESPONSE_HEADERS) break;
    out[name] = Array.isArray(value)
      ? value.map((v) => v.slice(0, MAX_HEADER_VALUE))
      : value.slice(0, MAX_HEADER_VALUE);
  }
  return out;
}
