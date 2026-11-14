import { describe, expect, test } from 'vitest';
import { formatBytes, formatDuration, timeAgo, timeUntil } from './format.ts';

describe('format', () => {
  test.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1536, '1.5 KB'],
    [1024 * 1024, '1.0 MB'],
  ])('formatBytes(%i) = %s', (n, expected) => {
    expect(formatBytes(n)).toBe(expected);
  });

  test('timeAgo', () => {
    const now = Date.parse('2026-11-14T12:00:00Z');
    const ago = (s: number) => timeAgo(new Date(now - s * 1000).toISOString(), now);
    expect(ago(2)).toBe('just now');
    expect(ago(42)).toBe('42 s ago');
    expect(ago(5 * 60 + 10)).toBe('5 min ago');
    expect(ago(3 * 3600)).toBe('3 h ago');
  });
});

describe('timeUntil / formatDuration', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const inS = (s: number) => timeUntil(new Date(now + s * 1000).toISOString(), now);

  test('timeUntil', () => {
    expect(inS(-5)).toBe('now');
    expect(inS(25)).toBe('in 25 s');
    expect(inS(150)).toBe('in 3 min');
  });

  test('formatDuration', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(42)).toBe('42 ms');
    expect(formatDuration(5012)).toBe('5.0 s');
  });
});
