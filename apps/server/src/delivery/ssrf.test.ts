import { describe, expect, test } from 'vitest';
import { fakeResolve } from '../testing/fake-dns.ts';
import { SsrfBlockedError, createGuardedLookup, isBlockedAddress, resolveAllowed } from './ssrf.ts';

describe('isBlockedAddress', () => {
  test.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '192.0.0.8',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  test.each([
    '93.184.216.34',
    '8.8.8.8',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
    '::ffff:808:808', // 8.8.8.8 in hex mapped form: unwrapped, then allowed (not over-blocked)
  ])('allows %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe('resolveAllowed', () => {
  const opts = { allowPrivate: false, resolve: fakeResolve };

  test('public hostname resolves', async () => {
    await expect(resolveAllowed('example.com', opts)).resolves.toEqual([
      { address: '93.184.216.34', family: 4 },
    ]);
  });

  test.each(['localhost', 'db.internal', 'metadata.cloud', 'v6local.test', 'rebind.example'])(
    'rejects %s (any blocked answer fails the whole lookup)',
    async (host) => {
      await expect(resolveAllowed(host, opts)).rejects.toBeInstanceOf(SsrfBlockedError);
    },
  );

  test('IP literals are checked without DNS', async () => {
    const resolve = () => Promise.reject(new Error('should not be called'));
    await expect(resolveAllowed('127.0.0.1', { allowPrivate: false, resolve })).rejects.toThrow(
      SsrfBlockedError,
    );
    await expect(resolveAllowed('8.8.8.8', { allowPrivate: false, resolve })).resolves.toEqual([
      { address: '8.8.8.8', family: 4 },
    ]);
  });

  test('allowPrivate lets internal answers through', async () => {
    await expect(resolveAllowed('db.internal', { ...opts, allowPrivate: true })).resolves.toEqual([
      { address: '10.0.0.5', family: 4 },
    ]);
  });

  test('NXDOMAIN propagates as a DNS error, not an SSRF error', async () => {
    const error = await resolveAllowed('nxdomain.example', opts).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(SsrfBlockedError);
    expect(error).toMatchObject({ code: 'ENOTFOUND' });
  });

  test('the error message does not reveal the resolved address', async () => {
    const error = await resolveAllowed('metadata.cloud', opts).catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain('169.254');
  });
});

describe('createGuardedLookup', () => {
  const lookup = createGuardedLookup({ allowPrivate: false, resolve: fakeResolve });
  const call = (host: string, options: object) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }>(
      (resolve) => {
        lookup(host, options, (err, address, family) => resolve({ err, address, family }));
      },
    );

  test('single answer', async () => {
    expect(await call('example.com', {})).toEqual({
      err: null,
      address: '93.184.216.34',
      family: 4,
    });
  });

  test('all: true returns the list', async () => {
    const { err, address } = await call('example.com', { all: true });
    expect(err).toBeNull();
    expect(address).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  test('blocked answer surfaces as an error to the socket', async () => {
    const { err } = await call('rebind.example', {});
    expect(err).toBeInstanceOf(SsrfBlockedError);
  });
});
