import { describe, expect, test } from 'vitest';
import { formatBytes, timeAgo } from './format.ts';

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
