// Deterministic DNS for tests (no network). Hostname patterns map to chosen answers.
import type { ResolveFn } from '../delivery/ssrf.ts';

export const PUBLIC_TEST_IP = '93.184.216.34';

export const fakeResolve: ResolveFn = async (hostname) => {
  if (hostname === 'localhost') return [{ address: '127.0.0.1', family: 4 }];
  if (hostname.endsWith('.internal')) return [{ address: '10.0.0.5', family: 4 }];
  if (hostname.startsWith('metadata.')) return [{ address: '169.254.169.254', family: 4 }];
  if (hostname.startsWith('v6local.')) return [{ address: 'fd00::1', family: 6 }];
  // DNS rebinding style answer: one public, one internal address.
  if (hostname.startsWith('rebind.')) {
    return [
      { address: PUBLIC_TEST_IP, family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];
  }
  if (hostname.startsWith('nxdomain.')) {
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
  }
  // Points at the local chaos receiver (only reachable when private addresses are allowed).
  if (hostname.endsWith('.chaos.test')) return [{ address: '127.0.0.1', family: 4 }];
  return [{ address: PUBLIC_TEST_IP, family: 4 }];
};
