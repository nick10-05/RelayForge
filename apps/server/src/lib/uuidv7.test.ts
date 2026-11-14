import { describe, expect, test } from 'vitest';
import { uuidv7, uuidv7Timestamp } from './uuidv7.ts';

const FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  test('has the RFC 9562 version 7 / variant 10 format', () => {
    for (let i = 0; i < 1000; i++) expect(uuidv7()).toMatch(FORMAT);
  });

  test('encodes the timestamp', () => {
    const now = Date.now() + 10_000; // ahead of anything generated so far in this process
    expect(uuidv7Timestamp(uuidv7(now))).toBe(now);
  });

  test('is strictly increasing within one millisecond', () => {
    const now = Date.now() + 20_000;
    const ids = Array.from({ length: 5000 }, () => uuidv7(now));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('stays increasing when the clock goes backwards', () => {
    const now = Date.now() + 30_000;
    const a = uuidv7(now);
    const b = uuidv7(now - 5000);
    expect(b > a).toBe(true);
  });

  test('is unique across many calls', () => {
    const ids = new Set(Array.from({ length: 20_000 }, () => uuidv7()));
    expect(ids.size).toBe(20_000);
  });
});
