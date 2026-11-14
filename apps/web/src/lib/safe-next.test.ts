import { describe, expect, test } from 'vitest';
import { safeNext } from './safe-next.ts';

describe('safeNext (no open redirect after login)', () => {
  test.each([
    ['/endpoints/abc?tab=events', '/endpoints/abc?tab=events'],
    ['/', '/'],
    [null, '/endpoints'],
    ['', '/endpoints'],
    ['https://evil.example', '/endpoints'],
    ['//evil.example/path', '/endpoints'],
    ['/\\evil.example', '/endpoints'],
    ['javascript:alert(1)', '/endpoints'],
    ['endpoints', '/endpoints'],
  ])('%j → %s', (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });
});
