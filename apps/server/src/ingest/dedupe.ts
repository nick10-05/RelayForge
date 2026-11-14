import type { DedupeSource } from '../db/schema.ts';

/** Longer keys are ignored (treated as absent) rather than truncated, which could collide. */
export const MAX_DEDUPE_KEY_LENGTH = 512;

export type DedupeConfig = { source: DedupeSource; name: string | null };
export type IncomingHeaders = Record<string, string | string[] | undefined>;

/**
 * The provider's event id for this request, or null when there is none — then every
 * request is a new event. We never hash bodies: identical payloads can be distinct events.
 */
export function extractDedupeKey(
  config: DedupeConfig,
  headers: IncomingHeaders,
  body: Buffer,
): string | null {
  if (config.source === 'none' || !config.name) return null;

  let raw: unknown;
  if (config.source === 'header') {
    const value = headers[config.name]; // Node lower-cases header names; so do we when saving
    raw = Array.isArray(value) ? value[0] : value;
  } else {
    raw = topLevelJsonField(body, config.name);
  }

  if (typeof raw === 'number' && Number.isFinite(raw)) raw = String(raw);
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  if (key.length === 0 || key.length > MAX_DEDUPE_KEY_LENGTH) return null;
  return key;
}

function topLevelJsonField(body: Buffer, field: string): unknown {
  if (body.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return Object.hasOwn(parsed, field) ? (parsed as Record<string, unknown>)[field] : undefined;
  } catch {
    return undefined;
  }
}
