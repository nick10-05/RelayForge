import { describe, expect, test } from 'vitest';
import { MAX_DEDUPE_KEY_LENGTH, extractDedupeKey } from './dedupe.ts';

const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const none = Buffer.alloc(0);

describe('extractDedupeKey', () => {
  test('source none → always null', () => {
    expect(extractDedupeKey({ source: 'none', name: null }, { 'x-id': 'a' }, none)).toBeNull();
  });

  test('header: reads the (lower-cased) header, trimmed; first value of a list', () => {
    const cfg = { source: 'header', name: 'x-github-delivery' } as const;
    expect(extractDedupeKey(cfg, { 'x-github-delivery': '  abc-123 ' }, none)).toBe('abc-123');
    expect(extractDedupeKey(cfg, { 'x-github-delivery': ['first', 'second'] }, none)).toBe('first');
    expect(extractDedupeKey(cfg, {}, none)).toBeNull();
    expect(extractDedupeKey(cfg, { 'x-github-delivery': '   ' }, none)).toBeNull();
  });

  test('json_field: top-level string or number field', () => {
    const cfg = { source: 'json_field', name: 'id' } as const;
    expect(extractDedupeKey(cfg, {}, json({ id: 'evt_1' }))).toBe('evt_1');
    expect(extractDedupeKey(cfg, {}, json({ id: 42 }))).toBe('42');
  });

  test.each([
    ['not JSON', Buffer.from('id=evt_1')],
    ['empty body', none],
    ['array', json([{ id: 'x' }])],
    ['nested only', json({ data: { id: 'x' } })],
    ['object value', json({ id: { nested: true } })],
    ['boolean value', json({ id: true })],
    ['null value', json({ id: null })],
    ['inherited key', json({ toString: undefined })],
  ])('json_field → null for %s', (_case, body) => {
    expect(extractDedupeKey({ source: 'json_field', name: 'id' }, {}, body)).toBeNull();
  });

  test('over-long keys are ignored, not truncated', () => {
    const cfg = { source: 'header', name: 'x-id' } as const;
    expect(extractDedupeKey(cfg, { 'x-id': 'a'.repeat(MAX_DEDUPE_KEY_LENGTH) }, none)?.length).toBe(
      MAX_DEDUPE_KEY_LENGTH,
    );
    expect(
      extractDedupeKey(cfg, { 'x-id': 'a'.repeat(MAX_DEDUPE_KEY_LENGTH + 1) }, none),
    ).toBeNull();
  });
});
