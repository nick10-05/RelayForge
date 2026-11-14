import { describe, expect, test } from 'vitest';
import { checkDestinationUrl } from './url.ts';

describe('checkDestinationUrl', () => {
  test.each([
    ['https://example.com/hook', 'https://example.com/hook'],
    ['https://example.com:8443/x?y=1', 'https://example.com:8443/x?y=1'],
    ['http://localhost:4000/hook', 'http://localhost:4000/hook'],
    ['https://example.com/x#frag', 'https://example.com/x'],
  ])('accepts %s (dev)', (input, normalised) => {
    expect(checkDestinationUrl(input, { production: false })).toEqual({
      ok: true,
      url: normalised,
    });
  });

  test.each([
    'not a url',
    '/relative/path',
    'ftp://example.com/',
    'javascript:alert(1)',
    'https://user:pass@example.com/',
    'https://user@example.com/',
    'https://example.com:22/',
    'http://example.com/',
  ])('rejects %s', (input) => {
    expect(checkDestinationUrl(input, { production: false }).ok).toBe(false);
  });

  test('production requires https', () => {
    expect(checkDestinationUrl('http://example.com:8080/', { production: true }).ok).toBe(false);
    expect(checkDestinationUrl('https://example.com/', { production: true }).ok).toBe(true);
  });
});
