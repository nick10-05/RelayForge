// A plain fetch-based SendFn for engine tests until the SSRF-safe client lands (Day 5).
import type { SendFn } from '../delivery/worker.ts';

export const simpleSender: SendFn = async (claim) => {
  const startedAt = new Date();
  try {
    const response = await fetch(claim.url, {
      method: 'POST',
      body: claim.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(claim.timeoutMs),
      headers: {
        'content-type': claim.contentType ?? 'application/octet-stream',
        'x-relayforge-id': claim.eventId,
        'x-relayforge-delivery-id': claim.id,
        'x-relayforge-attempt': String(claim.attemptCount),
      },
    });
    const text = await response.text();
    return {
      startedAt,
      durationMs: Date.now() - startedAt.getTime(),
      statusCode: response.status,
      responseBodySnippet: text.slice(0, 4096),
    };
  } catch (error) {
    return {
      startedAt,
      durationMs: Date.now() - startedAt.getTime(),
      errorCode: error instanceof Error ? error.name : 'error',
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
};
