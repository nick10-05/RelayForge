import { describe, expect, test } from 'vitest';
import { safeNext } from './safe-next.ts';

describe('safeNext (no open redirect after login)', () => {
  test.each([
    ['/endpoints/abc?tab=events', '/endpoints/abc?tab=events'],
    ['/', '/'],
    [null, '/overview'],
    ['', '/overview'],
    ['https://evil.example', '/overview'],
    ['//evil.example/path', '/overview'],
    ['/\\evil.example', '/overview'],
    ['javascript:alert(1)', '/overview'],
    ['endpoints', '/overview'],
  ])('%j → %s', (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });
});
